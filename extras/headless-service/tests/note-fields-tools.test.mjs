import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/mcp/tools.mjs';

const noteId = 'a'.repeat(32);
const revisionId = 'b'.repeat(32);
const bodyFile = { download_url: 'https://files.example.test/edited.md', file_id: 'edited-note' };
const fileBody = '# Edited from file\n';
const bodyPatch = '@@\n ## Travel plans\n-We arrive Monday.\n+We arrive Tuesday.\n';

/** Build writable note tools with spies for service arguments and the uploaded UTF-8 body. */
function fixture() {
	const created = [];
	const updated = [];
	const tools = createTools({
		async createNote(input) {
			created.push(input);
			return { id: noteId, title: input.title, notebook_id: input.notebook_id ?? input.parentId ?? null };
		},
		async updateNoteWithRevision(id, input) {
			updated.push({ id, input });
			return {
				id, updated_time: 20, revision_id: 'c'.repeat(32), previous_revision_id: revisionId, changed: true,
				...(typeof input.body === 'string' ? { body: input.body } : {}),
			};
		},
	}, {
		allowWrites: true,
		async readBodyFile(file) {
			assert.deepEqual(file, bodyFile);
			return fileBody;
		},
	});
	return { tools, created, updated };
}

test('note field schemas expose writable due and source URL values with clear semantics', () => {
	const { tools } = fixture();
	const definitions = Object.fromEntries(tools.list().map(tool => [tool.name, tool]));
	const create = definitions.create_note;
	const update = definitions.update_note;

	for (const definition of [create, update]) {
		assert.equal(definition.inputSchema.properties.todo_due.type, 'integer');
		assert.equal(Object.hasOwn(definition.inputSchema.properties.todo_due, 'minimum'), false);
		assert.match(definition.inputSchema.properties.todo_due.description, /Unix epoch milliseconds.*negative values.*0 to clear/i);
		assert.equal(definition.inputSchema.properties.source_url.type, 'string');
		assert.match(definition.inputSchema.properties.source_url.description, /empty string to clear/i);
		assert.equal(Object.hasOwn(definition.inputSchema.properties, 'source'), false);
		assert.equal(Object.hasOwn(definition.inputSchema.properties, 'source_application'), false);
	}
	assert.match(update.inputSchema.properties.source_url.description, /Omit to preserve/);
	assert.match(update.inputSchema.properties.is_todo.description, /resets its existing due date and completion state/i);
	assert.match(update.inputSchema.properties.is_todo.description, /explicitly supplied todo_due and todo_completed values are applied after that reset/i);
	assert.equal(update.inputSchema.properties.body_patch.type, 'string');
	assert.match(update.inputSchema.properties.body_patch.description, /bare @@ line.*space.*removed.*added/s);
	assert.match(update.inputSchema.properties.body_patch.description, /exactly once in the original body.*source-ordered and nonoverlapping/);
	assert.match(update.inputSchema.properties.body_patch.description, /Combine hunks that would share context/);
	assert.match(update.inputSchema.properties.body_patch.description, /final newline.*matched no-op/);
	assert.equal(update.inputSchema.minProperties, 3, 'metadata changes count as standalone updates');
	assert.equal(Object.hasOwn(update.inputSchema, 'anyOf'), false, 'file properties stay only at the root schema');
	assert.deepEqual(create._meta, { 'openai/fileParams': ['body_file'] });
	assert.deepEqual(update._meta, { 'openai/fileParams': ['body_file'] });
	assert.equal(Object.hasOwn(create.inputSchema.properties.body_file.properties, 'source_url'), false);
	for (const branch of create.inputSchema.anyOf) assert.equal(Object.hasOwn(branch, 'properties'), false);
});

test('create_note forwards metadata with inline, omitted and file bodies', async () => {
	const { tools, created } = fixture();
	const due = 1700000000123;
	const sourceUrl = 'https://example.test/article';

	const inline = await tools.call('create_note', {
		title: 'Inline todo', notebook_id: noteId, body: 'inline body', is_todo: true, todo_due: due, source_url: sourceUrl,
	});
	const omitted = await tools.call('create_note', {
		title: 'Empty todo', notebook_id: noteId, is_todo: false, todo_due: 0, source_url: '',
	});
	const fromFile = await tools.call('create_note', {
		title: 'File todo', notebook_id: noteId, body_file: bodyFile, is_todo: true, todo_due: due, source_url: sourceUrl,
	});

	assert.equal(inline.isError, false);
	assert.equal(omitted.isError, false);
	assert.equal(fromFile.isError, false);
	assert.deepEqual(created, [
		{ title: 'Inline todo', notebook_id: noteId, body: 'inline body', is_todo: true, todo_due: due, source_url: sourceUrl },
		{ title: 'Empty todo', notebook_id: noteId, is_todo: false, todo_due: 0, source_url: '' },
		{ title: 'File todo', notebook_id: noteId, is_todo: true, todo_due: due, source_url: sourceUrl, body: fileBody },
	]);
	for (const result of [inline, omitted, fromFile]) {
		assert.deepEqual(Object.keys(result.structuredContent).sort(), ['id', 'notebook_id', 'title']);
		assert.equal(JSON.stringify(result.structuredContent).includes(fileBody), false);
	}
});

test('update_note accepts standalone metadata edits and forwards them with body_file', async () => {
	const { tools, updated } = fixture();
	const identifiers = { id: noteId, base_revision_id: revisionId };
	const standalone = await tools.call('update_note', { ...identifiers, todo_due: -1, source_url: '' });
	const fileUpdate = await tools.call('update_note', {
		...identifiers, body_file: bodyFile, todo_due: 1700000000123, source_url: 'https://example.test/article',
	});

	assert.equal(standalone.isError, false);
	assert.equal(fileUpdate.isError, false);
	assert.deepEqual(updated, [
		{ id: noteId, input: { base_revision_id: revisionId, todo_due: -1, source_url: '' } },
		{ id: noteId, input: { base_revision_id: revisionId, todo_due: 1700000000123, source_url: 'https://example.test/article', body: fileBody } },
	]);
	assert.deepEqual(Object.keys(standalone.structuredContent).sort(), ['changed', 'id', 'previous_revision_id', 'revision_id', 'updated_time']);
	assert.deepEqual(Object.keys(fileUpdate.structuredContent).sort(), ['body_length', 'body_sha256', 'body_size_bytes', 'body_total_line_count', 'changed', 'id', 'previous_revision_id', 'revision_id', 'updated_time']);
	assert.equal(Object.hasOwn(fileUpdate.structuredContent, 'body'), false);
});

test('update_note forwards body_patch with metadata and keeps its acknowledgment compact', async () => {
	const { tools, updated } = fixture();
	const title = 'Revised travel plan';
	const sourceUrl = 'https://example.test/itinerary';
	const result = await tools.call('update_note', {
		id: noteId, base_revision_id: revisionId, body_patch: bodyPatch, title, source_url: sourceUrl,
	});

	assert.equal(result.isError, false);
	assert.deepEqual(updated, [{
		id: noteId,
		input: { base_revision_id: revisionId, body_patch: bodyPatch, title, source_url: sourceUrl },
	}]);
	assert.deepEqual(Object.keys(result.structuredContent).sort(), ['changed', 'id', 'previous_revision_id', 'revision_id', 'updated_time']);
	assert.equal(result.content[0].text.includes(bodyPatch), false);
	assert.equal(result.content[0].text.includes('We arrive Tuesday.'), false);
});
