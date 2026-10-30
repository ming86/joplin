import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTools } from '../src/mcp/tools.mjs';
import { ServiceError } from '../src/errors.mjs';

const noteId = 'a'.repeat(32);
const notebookId = 'b'.repeat(32);
const bodyFile = { download_url: 'https://files.example.test/generated?secret=hidden', file_id: 'generated-note' };

/** Build a writable catalog with a small fake create service. */
function fixture(t, overrides = {}, options = {}) {
	const service = {
		async createNoteWithRevision(args) {
			const notebook_id = args.notebook_id ?? args.parentId ?? notebookId;
			return { id: noteId, title: args.title, notebook_id, parent_id: notebook_id, updated_time: 20, revision_id: 'c'.repeat(32), body: args.body ?? '' };
		},
		...overrides,
	};
	return createTools(service, { allowWrites: true, ...options });
}

/** Calculate the four measurement fields for an exact saved body. */
function bodyMetrics(text) {
	return {
		body_length: text.length,
		body_size_bytes: Buffer.byteLength(text, 'utf8'),
		body_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
		body_total_line_count: (text.match(/\r\n|\n|\r/g) ?? []).length + 1,
	};
}

test('create_note accepts a large UTF-8 file body and measures the committed snapshot without returning its body', async t => {
	const generatedBody = '\uFEFF# Generated 🧪\r\n' + 'large body 🌿\n'.repeat(100000);
	const savedBody = '\uFEFF# Native snapshot 🪵\r\nCommitted text\n';
	const signal = new AbortController().signal;
	let saved;
	let reads = 0;
	const tools = fixture(t, {
		async createNoteWithRevision(args, receivedSignal) {
			assert.equal(receivedSignal, signal);
			saved = args;
			return { id: noteId, title: args.title, notebook_id: args.notebook_id, updated_time: 21, revision_id: 'd'.repeat(32), body: savedBody };
		},
	}, {
		async readBodyFile(file, receivedSignal) {
			reads++;
			assert.deepEqual(file, bodyFile);
			assert.equal(receivedSignal, signal);
			return generatedBody;
		},
	});
	const definition = tools.list().find(tool => tool.name === 'create_note');
	assert.deepEqual(definition._meta, { 'openai/fileParams': ['body_file'] });
	assert.deepEqual(Object.keys(definition.inputSchema.properties.body_file.properties), ['download_url', 'file_id', 'mime_type', 'file_name']);
	assert.deepEqual(definition.inputSchema.properties.body_file.required, ['download_url', 'file_id']);
	assert.match(definition.inputSchema.properties.body_file.description, /large generated notes.*validated as UTF-8 before note creation/);
	assert.match(definition.description, /body_file for large generated note bodies/);
	assert.match(definition.description, /native revision_id.*base_revision_id/);
	assert.match(definition.description, /measurements.*committed body/);
	assert.deepEqual(definition.inputSchema.anyOf, [
		{ required: ['notebook_id'] },
		{ required: ['parentId'] },
	]);
	assert.equal(definition.inputSchema.additionalProperties, false);

	const result = await tools.call('create_note', {
		title: 'Generated note', notebook_id: notebookId, is_todo: true, body_file: bodyFile,
	}, signal);
	assert.equal(reads, 1);
	assert.deepEqual(saved, {
		title: 'Generated note', notebook_id: notebookId, is_todo: true, body: generatedBody,
	});
	assert.deepEqual(result.structuredContent, {
		id: noteId, title: 'Generated note', notebook_id: notebookId, updated_time: 21, revision_id: 'd'.repeat(32),
		...bodyMetrics(savedBody),
	});
	assert.equal(result.content[0].text.includes(generatedBody), false);
	assert.equal(result.content[0].text.includes(savedBody), false);
});

test('create_note file parameter keeps destination, nested-file and closed-object validation', async t => {
	let writes = 0;
	const tools = fixture(t, { async createNoteWithRevision() { writes++; return { id: noteId, title: 'Unexpected' }; } });
	const validFile = { download_url: bodyFile.download_url, file_id: bodyFile.file_id };

	const missingDestination = await tools.call('create_note', { title: 'Missing destination', body_file: validFile });
	assert.equal(missingDestination.structuredContent.error.code, 'notebook_id_required');
	for (const args of [
		{ title: 'Missing file id', notebook_id: notebookId, body_file: { download_url: bodyFile.download_url } },
		{ title: 'Unknown root field', notebook_id: notebookId, body_file: validFile, local_path: '/tmp/body.md' },
		{ title: 'Unknown file field', notebook_id: notebookId, body_file: { ...validFile, local_path: '/tmp/body.md' } },
	]) {
		const result = await tools.call('create_note', args);
		assert.equal(result.structuredContent.error.code, 'invalid_tool_arguments');
	}
	assert.equal(writes, 0);
});

test('create_note rejects body and body_file together, including an empty inline body, before reading or writing', async t => {
	let reads = 0;
	let writes = 0;
	const tools = fixture(t, {
		async createNoteWithRevision() { writes++; throw new Error('should not create'); },
	}, { async readBodyFile() { reads++; return 'file body'; } });
	const result = await tools.call('create_note', {
		title: 'Conflict', notebook_id: notebookId, body: '', body_file: bodyFile,
	});
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.error.code, 'note_file_body_conflict');
	assert.equal(reads, 0);
	assert.equal(writes, 0);
});

test('create_note does not create a note when the downloaded file is invalid UTF-8', async t => {
	let writes = 0;
	const tools = fixture(t, {
		async createNoteWithRevision() { writes++; throw new Error('should not create'); },
	}, { async readBodyFile() { throw new ServiceError('note_file_invalid_utf8'); } });
	const result = await tools.call('create_note', { title: 'Invalid', notebook_id: notebookId, body_file: bodyFile });
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.error.code, 'note_file_invalid_utf8');
	assert.match(result.structuredContent.error.message, /valid UTF-8/);
	assert.equal(writes, 0);
});

test('inline and body-free create_note payloads retain input fields and report all committed-body measurements', async t => {
	const calls = [];
	const tools = fixture(t, {
		async createNoteWithRevision(args) {
			calls.push(args);
			const parent_id = args.notebook_id ?? args.parentId;
			return { id: noteId, title: args.title, parent_id, updated_time: 30, revision_id: 'e'.repeat(32), body: args.body ?? '' };
		},
	}, { async readBodyFile() { throw new Error('inline creates should not download'); } });
	const inline = await tools.call('create_note', {
		title: 'Inline', parentId: notebookId, body: '# Inline', is_todo: true,
	});
	const metadataOnly = await tools.call('create_note', { title: 'Empty', notebook_id: notebookId });
	assert.deepEqual(calls, [
		{ title: 'Inline', parentId: notebookId, body: '# Inline', is_todo: true },
		{ title: 'Empty', notebook_id: notebookId },
	]);
	assert.deepEqual(inline.structuredContent, {
		id: noteId, title: 'Inline', notebook_id: notebookId, updated_time: 30, revision_id: 'e'.repeat(32), ...bodyMetrics('# Inline'),
	});
	assert.deepEqual(metadataOnly.structuredContent, {
		id: noteId, title: 'Empty', notebook_id: notebookId, updated_time: 30, revision_id: 'e'.repeat(32), ...bodyMetrics(''),
	});
	assert.equal(Object.hasOwn(inline.structuredContent, 'body'), false);
});

test('create_note returns an unknown outcome if the committed snapshot body is missing', async t => {
	const tools = fixture(t, {
		async createNoteWithRevision() {
			return { id: noteId, title: 'Uncertain', notebook_id: notebookId, updated_time: 30, revision_id: 'e'.repeat(32) };
		},
	});
	const result = await tools.call('create_note', { title: 'Uncertain', notebook_id: notebookId });
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.error.code, 'write_outcome_unknown');
	assert.equal(result.structuredContent.error.outcomeUnknown, true);
});
