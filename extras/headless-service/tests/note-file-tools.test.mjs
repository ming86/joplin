import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createTools } from '../src/mcp/tools.mjs';
import { createNoteFileResources } from '../src/mcp/note-file-resources.mjs';
import { ServiceError } from '../src/errors.mjs';
import { createPayloadCapacity, defaultRetainedExportBytes } from '../src/payload-capacity.mjs';
import { createNoteBodyFileReader } from '../src/mcp/note-file-input.mjs';

const noteId = 'a'.repeat(32);
const revisionId = 'b'.repeat(32);
const nextRevisionId = 'c'.repeat(32);
const bodyPatch = '@@\n ## Travel plans\n-We arrive Monday.\n+We arrive Tuesday.\n';
const note = {
	id: noteId, accountId: 'alice', title: 'Exact note', parent_id: 'd'.repeat(32),
	body: 'Initial 🔧\r\n', markup_language: 1, is_todo: 1, todo_completed: 0,
	revision_id: revisionId, previous_revision_id: null, changed: false, updated_time: 10,
};
const bodyFile = { download_url: 'https://files.example.test/edited?secret=hidden', file_id: 'file-edited' };

/** Build a tool catalog with the production snapshot store and a bounded fake service. */
function fixture(t, overrides = {}, options = {}) {
	const store = createNoteFileResources();
	t.after(() => store.close());
	const service = {
		async readNoteWithRevision() { return { ...note }; },
		async updateNoteWithRevision() { return { ...note, updated_time: 20, revision_id: nextRevisionId, previous_revision_id: revisionId, changed: true }; },
		...overrides,
	};
	return { store, tools: createTools(service, { allowWrites: true, noteFileResources: store, ...options }) };
}

test('file read preserves exact multi-megabyte UTF-8 body only in its embedded resource', async t => {
	const body = '\uFEFF# Full 🔧\r\n'.repeat(220000) + '\nEND';
	let reads = 0;
	const { tools, store } = fixture(t, {
		async readNoteWithRevision(id) { reads++; assert.equal(id, noteId); return { ...note, body }; },
	});
	const result = await tools.call('read_note', { id: noteId, output: 'file' });
	assert.equal(result.isError, false);
	assert.equal(reads, 1);
	const metadata = result.structuredContent;
	assert.equal(Object.hasOwn(metadata, 'body'), false);
	assert.equal(metadata.revision_id, revisionId);
	assert.equal(metadata.is_todo, true);
	assert.equal(metadata.todo_completed, false);
	assert.equal(metadata.file.size, Buffer.byteLength(body));
	assert.equal(metadata.file.sha256, createHash('sha256').update(body).digest('hex'));
	assert.match(metadata.file.filename, /\.md$/);
	assert.equal(metadata.file.mime_type, 'text/markdown; charset=utf-8');
	assert.ok(Date.parse(metadata.file.expires_at) > Date.now());
	assert.deepEqual(JSON.parse(result.content[0].text), metadata);
	assert.equal(result.content[0].text.includes('Full 🔧'), false);
	assert.equal(result.content.length, 2);
	const resource = result.content[1];
	assert.equal(resource.type, 'resource');
	assert.equal(resource.resource.uri, metadata.file.uri);
	assert.equal(Buffer.from(resource.resource.blob, 'base64').toString('utf8'), body);
	assert.deepEqual(store.read(metadata.file.uri).contents, [resource.resource]);
	assert.equal(JSON.stringify(metadata).includes(resource.resource.blob), false);
});

test('file reads retain alias numeric fields and HTML context, and inline slicing stays unchanged', async t => {
	const { tools } = fixture(t, { async readNoteWithRevision() { return { ...note, markup_language: 2, body: '<p>🔧HTML</p>' }; } });
	const file = await tools.call('get_note', { id: noteId, output: 'file' });
	assert.equal(file.structuredContent.is_todo, 1);
	assert.equal(file.structuredContent.todo_completed, 0);
	assert.match(file.structuredContent.file.filename, /\.html$/);
	assert.equal(file.content[1].resource.mimeType, 'text/html; charset=utf-8');
	const inline = await tools.call('read_note', { id: noteId, offset: 3, max_chars: 1 });
	assert.equal(inline.structuredContent.body, '🔧');
	assert.equal(inline.structuredContent.body_returned_chars, 2);
	assert.equal(inline.structuredContent.nextOffset, 5);
	assert.equal(Object.hasOwn(inline.structuredContent, 'file'), false);
	const defaultRead = await tools.call('read_note', { id: noteId });
	assert.equal(defaultRead.structuredContent.body, '<p>🔧HTML</p>');
	assert.equal(defaultRead.content.length, 1);
});

test('read_note and get_note report whole-body line counts in every output mode', async t => {
	const body = 'first\r\nsecond\nthird\rfour\n';
	let currentBody = body;
	const { tools } = fixture(t, { async readNoteWithRevision() { return { ...note, body: currentBody }; } });
	for (const name of ['read_note', 'get_note']) {
		const inline = await tools.call(name, { id: noteId, offset: 7, max_chars: 2 });
		assert.equal(inline.structuredContent.body, 'se');
		assert.equal(inline.structuredContent.body_total_line_count, 5);
		assert.equal((await tools.call(name, { id: noteId, output: 'metadata' })).structuredContent.body_total_line_count, 5);
		assert.equal((await tools.call(name, { id: noteId, output: 'file' })).structuredContent.body_total_line_count, 5);
	}
	currentBody = '';
	assert.equal((await tools.call('read_note', { id: noteId, output: 'metadata' })).structuredContent.body_total_line_count, 1);
});

test('line reads preserve exact separators, report the clamped inclusive range, and use one revision snapshot', async t => {
	const body = 'alpha\r\nbeta\rgamma\n';
	let reads = 0;
	const { tools } = fixture(t, {
		async readNoteWithRevision() { reads++; return { ...note, body, revision_id: revisionId }; },
	});

	const middle = await tools.call('read_note', { id: noteId, start_line: 2, end_line: 2 });
	assert.equal(middle.isError, false);
	assert.equal(reads, 1);
	assert.equal(middle.structuredContent.body, 'beta\r');
	assert.equal(middle.structuredContent.body_start_line, 2);
	assert.equal(middle.structuredContent.body_end_line, 2);
	assert.equal(middle.structuredContent.body_offset, 7);
	assert.equal(middle.structuredContent.body_returned_chars, 5);
	assert.equal(middle.structuredContent.has_more, true);
	assert.equal(middle.structuredContent.nextOffset, 12);
	assert.equal(middle.structuredContent.body_total_line_count, 4);
	assert.equal(middle.structuredContent.revision_id, revisionId);

	const fromEnd = await tools.call('get_note', { id: noteId, end_line: 1 });
	assert.equal(fromEnd.structuredContent.body, 'alpha\r\n');
	assert.equal(fromEnd.structuredContent.body_start_line, 1);
	assert.equal(fromEnd.structuredContent.body_end_line, 1);
	assert.equal(fromEnd.structuredContent.is_todo, 1);

	const throughEnd = await tools.call('read_note', { id: noteId, start_line: 3 });
	assert.equal(throughEnd.structuredContent.body, 'gamma\n');
	assert.equal(throughEnd.structuredContent.body_start_line, 3);
	assert.equal(throughEnd.structuredContent.body_end_line, 4);
	const trailingEmptyLine = await tools.call('read_note', { id: noteId, start_line: 4, end_line: 4 });
	assert.equal(trailingEmptyLine.structuredContent.body, '');
	assert.equal(trailingEmptyLine.structuredContent.body_start_line, 4);
	assert.equal(trailingEmptyLine.structuredContent.body_end_line, 4);

	const clamped = await tools.call('read_note', { id: noteId, start_line: 3, end_line: 99 });
	assert.equal(clamped.structuredContent.body, 'gamma\n');
	assert.equal(clamped.structuredContent.body_start_line, 3);
	assert.equal(clamped.structuredContent.body_end_line, 4);

	const beyondEnd = await tools.call('read_note', { id: noteId, start_line: 99 });
	assert.equal(beyondEnd.structuredContent.body, '');
	assert.equal(beyondEnd.structuredContent.body_start_line, null);
	assert.equal(beyondEnd.structuredContent.body_end_line, null);
	assert.equal(beyondEnd.structuredContent.body_offset, body.length);
	assert.equal(beyondEnd.structuredContent.body_returned_chars, 0);
});

test('line reads represent the empty body and its one empty logical line', async t => {
	const { tools } = fixture(t, { async readNoteWithRevision() { return { ...note, body: '' }; } });
	const result = await tools.call('read_note', { id: noteId, start_line: 1, end_line: 1 });
	assert.equal(result.structuredContent.body, '');
	assert.equal(result.structuredContent.body_start_line, 1);
	assert.equal(result.structuredContent.body_end_line, 1);
	assert.equal(result.structuredContent.body_total_line_count, 1);
	const wholeBody = await tools.call('read_note', { id: noteId });
	assert.equal(Object.hasOwn(wholeBody.structuredContent, 'body_start_line'), false);
});

test('line selectors reject character slicing and reversed ranges before reading', async t => {
	let reads = 0;
	const { tools } = fixture(t, { async readNoteWithRevision() { reads++; return note; } });
	for (const selector of [
		{ start_line: 1, offset: 0 },
		{ end_line: 1, max_chars: 0 },
		{ start_line: 2, length: 1 },
	]) {
		const result = await tools.call('read_note', { id: noteId, ...selector });
		assert.equal(result.structuredContent.error.code, 'note_slice_conflict');
		assert.match(result.structuredContent.error.message, /Line selectors/);
	}
	const reversed = await tools.call('read_note', { id: noteId, start_line: 3, end_line: 2 });
	assert.equal(reversed.structuredContent.error.code, 'invalid_note_line_range');
	assert.match(reversed.structuredContent.error.message, /end_line/);
	assert.equal(reads, 0);
});

test('file mode explicitly rejects every slicing selector before reading the note', async t => {
	let reads = 0;
	const { tools } = fixture(t, { async readNoteWithRevision() { reads++; return note; } });
	for (const output of ['file', 'metadata']) {
		for (const selector of [{ offset: 0 }, { max_chars: 0 }, { length: 1 }, { start_line: 1 }, { end_line: 1 }]) {
			const result = await tools.call('read_note', { id: noteId, output, ...selector });
			assert.equal(result.isError, true);
			assert.equal(result.structuredContent.error.code, 'note_file_slice_conflict');
			assert.match(result.structuredContent.error.message, /body selectors/);
		}
	}
	assert.equal(reads, 0);
});

test('catalog publishes a fixed file-input object and object output variants', async t => {
	const { tools } = fixture(t);
	const update = tools.list().find(tool => tool.name === 'update_note');
	assert.deepEqual(update._meta, { 'openai/fileParams': ['body_file'] });
	assert.deepEqual(Object.keys(update.inputSchema.properties.body_file.properties), ['download_url', 'file_id', 'mime_type', 'file_name']);
	assert.deepEqual(update.inputSchema.properties.body_file.required, ['download_url', 'file_id']);
	assert.match(update.inputSchema.properties.body_file.description, /any body operation.*body_length, body_size_bytes, body_sha256 and body_total_line_count.*edited local file byte count.*SHA-256/);
	assert.match(update.description, /Any supplied body, body_file, body_patch or replace_text includes body_length, body_size_bytes, body_sha256 and body_total_line_count/);
	assert.match(update.description, /Prefer updating the existing passage/);
	assert.match(update.description, /intentional boundary addition.*enough exact context.*metadata-only reads do not provide source text/);
	assert.equal(Object.hasOwn(update.inputSchema.properties, 'prepend'), false);
	assert.equal(Object.hasOwn(update.inputSchema.properties, 'append'), false);
	assert.match(update.description, /metadata-only updates omit all four measurements/i);
	assert.equal(update.inputSchema.type, 'object');
	assert.deepEqual(update.inputSchema.required, ['id', 'base_revision_id']);
	assert.equal(update.inputSchema.additionalProperties, false);
	assert.equal(update.inputSchema.minProperties, 3);
	assert.equal(Object.hasOwn(update.inputSchema, 'anyOf'), false);
	for (const name of ['read_note', 'get_note']) {
		const definition = tools.list().find(tool => tool.name === name);
		assert.deepEqual(definition.inputSchema.properties.output.enum, ['inline', 'file', 'metadata']);
		assert.equal(definition.outputSchema.type, 'object');
		const success = definition.outputSchema.anyOf[0];
		assert.deepEqual(success.properties.body_start_line.type, ['integer', 'null']);
		assert.deepEqual(success.properties.body_end_line.type, ['integer', 'null']);
		assert.equal(success.type, 'object');
		assert.equal(success.properties.file.type, 'object');
		const inline = success.anyOf.find(branch => branch.required.includes('body'));
		const file = success.anyOf.find(branch => branch.required.includes('file'));
		assert.ok(inline.not.anyOf.some(branch => branch.required.includes('file')));
		assert.ok(file.not.anyOf.some(branch => branch.required.includes('body')));
		const value = (await tools.call(name, { id: noteId, output: 'file' })).structuredContent;
		for (const field of [...success.required, ...file.required]) assert.ok(Object.hasOwn(value, field), field);
		for (const field of success.properties.file.required) assert.ok(Object.hasOwn(value.file, field), field);
	}
	const updateOutput = update.outputSchema.anyOf[0];
	assert.deepEqual(updateOutput.required, ['id', 'updated_time', 'revision_id', 'previous_revision_id', 'changed']);
	for (const field of ['body_length', 'body_size_bytes', 'body_sha256', 'body_total_line_count']) assert.ok(updateOutput.properties[field], field);
	assert.deepEqual(updateOutput.anyOf, [
		{ not: { anyOf: [{ required: ['body_length'] }, { required: ['body_size_bytes'] }, { required: ['body_sha256'] }, { required: ['body_total_line_count'] }] } },
		{ required: ['body_length', 'body_size_bytes', 'body_sha256', 'body_total_line_count'] },
	]);
	assert.match(updateOutput.properties.body_length.description, /UTF-16/);
	assert.equal(updateOutput.properties.body_size_bytes.type, 'integer');
	assert.equal(updateOutput.properties.body_sha256.pattern, '^[a-f0-9]{64}$');
});

test('fixed update input rejects empty changes and accepts metadata-only changes', async t => {
	const saves = [];
	const { tools } = fixture(t, {
		async updateNoteWithRevision(_id, changes) { saves.push(changes); return note; },
	});
	const identifiers = { id: noteId, base_revision_id: revisionId };
	const empty = await tools.call('update_note', identifiers);
	assert.equal(empty.structuredContent.error.code, 'invalid_tool_arguments');
	assert.equal(saves.length, 0);
	for (const changes of [{ title: 'New title' }, { todo_completed: false }]) {
		const result = await tools.call('update_note', { ...identifiers, ...changes });
		assert.equal(result.isError, false);
		assert.deepEqual(saves.at(-1), { base_revision_id: revisionId, ...changes });
	}
});

test('removed update fields are rejected before body-file downloads or note saves', async t => {
	let downloads = 0;
	const saves = [];
	const { tools } = fixture(t, {
		async updateNoteWithRevision(_id, changes) { saves.push(changes); return note; },
	}, { readBodyFile: async () => { downloads++; return 'edited'; } });
	const cases = [
		{ prepend: '' },
		{ prepend: 'Beginning', title: 'Valid metadata' },
		{ prepend: 'Beginning', body: 'Valid body' },
		{ prepend: 'Beginning', body_file: bodyFile },
		{ append: '' },
		{ append: 'Ending', title: 'Valid metadata' },
		{ append: 'Ending', body: 'Valid body' },
		{ append: 'Ending', body_file: bodyFile },
	];
	for (const change of cases) {
		const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, ...change });
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent.error.code, 'invalid_tool_arguments');
	}
	assert.equal(downloads, 0);
	assert.equal(saves.length, 0);
});

test('body_file update returns measurements for the saved body, not the downloaded text', async t => {
	const submittedBody = '\uFEFF# submitted 🔧\r\n' + 'complete body\n'.repeat(200000);
	const savedBody = '\uFEFF# returned native snapshot 🪵\r\nSaved complete body\n';
	const signal = new AbortController().signal;
	let saved;
	const { tools } = fixture(t, {
		async updateNoteWithRevision(id, changes, receivedSignal) {
			assert.equal(id, noteId);
			assert.equal(receivedSignal, signal);
			saved = changes;
			return { ...note, body: savedBody, updated_time: 20, revision_id: nextRevisionId, previous_revision_id: revisionId, changed: true };
		},
	}, {
		allowAttachmentWrites: false,
		readBodyFile: async (file, receivedSignal) => { assert.deepEqual(file, bodyFile); assert.equal(receivedSignal, signal); return submittedBody; },
	});
	assert.equal(tools.has('create_attachment'), false);
	assert.equal(tools.has('update_attachment'), false);
	const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile, title: 'Edited', todo_completed: true }, signal);
	assert.deepEqual(saved, { base_revision_id: revisionId, body: submittedBody, title: 'Edited', todo_completed: true });
	assert.deepEqual(result.structuredContent, {
		id: noteId, updated_time: 20, revision_id: nextRevisionId, previous_revision_id: revisionId, changed: true,
		body_length: savedBody.length,
		body_size_bytes: Buffer.byteLength(savedBody, 'utf8'),
		body_sha256: createHash('sha256').update(savedBody, 'utf8').digest('hex'),
		body_total_line_count: 3,
	});
	assert.notEqual(result.structuredContent.body_sha256, createHash('sha256').update(submittedBody, 'utf8').digest('hex'));
	assert.notEqual(result.structuredContent.body_total_line_count, 200002);
	assert.equal(result.content[0].text.includes('Saved complete body'), false);
});

test('body_file no-op acknowledgments measure the returned unchanged saved body', async t => {
	const { tools } = fixture(t, {
		async updateNoteWithRevision(_id, changes) {
			assert.deepEqual(changes, { base_revision_id: revisionId, body: note.body });
			return { ...note, changed: false };
		},
	}, { readBodyFile: async () => note.body });
	const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile });
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent, {
		id: noteId, updated_time: 10, revision_id: revisionId, previous_revision_id: null, changed: false,
		body_length: note.body.length,
		body_size_bytes: Buffer.byteLength(note.body, 'utf8'),
		body_sha256: createHash('sha256').update(note.body, 'utf8').digest('hex'),
		body_total_line_count: 2,
	});
});

test('body operations report unknown outcome when the saved snapshot has no usable body', async t => {
	let writes = 0;
	const savedSnapshots = [
		{ ...note, body: undefined },
		{ ...note, body: null },
		{ ...note, body: Buffer.from('not a decoded body') },
	];
	const { tools } = fixture(t, {
		async updateNoteWithRevision() {
			return savedSnapshots[writes++];
		},
	}, { readBodyFile: async () => 'submitted body' });
	for (let index = 0; index < savedSnapshots.length; index++) {
		const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile });
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent.error.code, 'write_outcome_unknown');
		assert.equal(result.structuredContent.error.outcomeUnknown, true);
		assert.match(result.structuredContent.error.action, /may have committed/);
	}
	assert.equal(writes, savedSnapshots.length);
});

test('non-file update acknowledgments retain their original compact fields', async t => {
	const { tools } = fixture(t);
	const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, title: 'Edited' });
	assert.deepEqual(result.structuredContent, {
		id: noteId, updated_time: 20, revision_id: nextRevisionId, previous_revision_id: revisionId, changed: true,
	});
});

test('supported body-mode conflicts never download or save, while body and replace_text remain accepted together', async t => {
	let downloads = 0;
	const saves = [];
	const { tools } = fixture(t, {
		async updateNoteWithRevision(_id, changes) { saves.push(changes); return note; },
	}, { readBodyFile: async () => { downloads++; return 'edited'; } });
	for (const conflict of [{ body: '' }, { replace_text: { find: 'a', replace: 'b' } }]) {
		const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile, ...conflict });
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent.error.code, 'note_file_body_conflict');
	}
	for (const conflict of [
		{ body_file: bodyFile },
		{ body: 'replacement' },
		{ replace_text: { find: 'a', replace: 'b' } },
	]) {
		const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_patch: bodyPatch, ...conflict });
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent.error.code, 'note_patch_body_conflict');
		assert.equal(result.structuredContent.error.message, 'body_patch cannot be combined with body_file, body or replace_text. Choose one body-edit mode.');
	}
	assert.equal(downloads, 0);
	assert.equal(saves.length, 0);
	const replaceText = { find: 'old passage', replace: 'new passage' };
	const accepted = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body: 'rewrite', replace_text: replaceText });
	assert.equal(accepted.isError, false);
	assert.deepEqual(saves, [{ base_revision_id: revisionId, body: 'rewrite', replace_text: replaceText }]);
});

test('body patch failures return fixed safe messages', async t => {
	const expectedMessages = new Map([
		['note_patch_invalid', 'Each body_patch hunk needs a source line and an edit; a - line counts as both. Prefix blank body lines, and put a bare @@ before each hunk.'],
		['note_patch_not_found', 'A body_patch source sequence was not found. Read the current source and correct the patch.'],
		['note_patch_ambiguous', 'A body_patch source sequence is not unique. Add unchanged context to identify one occurrence.'],
		['note_patch_order', 'body_patch hunks overlap or are out of source order. Combine hunks that share context or reorder them.'],
		['note_patch_body_conflict', 'body_patch cannot be combined with body_file, body or replace_text. Choose one body-edit mode.'],
	]);
	for (const [code, message] of expectedMessages) {
		const { tools } = fixture(t, {
			async updateNoteWithRevision() { throw new ServiceError(code, false, `private backend detail: ${code}`); },
		});
		const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_patch: bodyPatch });
		assert.equal(result.isError, true);
		assert.deepEqual(result.structuredContent.error, { code, message, outcomeUnknown: false });
		assert.equal(result.content[0].text.includes('private backend detail'), false);
	}
});

test('file updates require a native base revision and propagate stale revision failures without fallback', async t => {
	let saves = 0;
	const { tools } = fixture(t, { async updateNoteWithRevision(_id, changes) {
		saves++;
		assert.equal(changes.base_revision_id, revisionId);
		throw new ServiceError('note_conflict', false, 'secret backend details');
	} }, { readBodyFile: async () => 'edited' });
	const missing = await tools.call('update_note', { id: noteId, body_file: bodyFile });
	assert.equal(missing.structuredContent.error.code, 'invalid_tool_arguments');
	assert.equal(saves, 0);
	const stale = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile });
	assert.equal(stale.structuredContent.error.code, 'note_conflict');
	assert.equal(stale.content[0].text.includes('secret backend'), false);
	assert.equal(saves, 1);
});

test('file failures have helpful safe errors and do not reach the native write', async t => {
	let saves = 0;
	const { tools } = fixture(t, { async updateNoteWithRevision() { saves++; } }, {
		readBodyFile: async () => { throw new ServiceError('note_file_download_failed', false, bodyFile.download_url); },
	});
	const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile });
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.error.code, 'note_file_download_failed');
	assert.match(result.structuredContent.error.message, /fresh accessible file/);
	assert.equal(result.content[0].text.includes('secret=hidden'), false);
	assert.equal(saves, 0);
});


test('file updates reject exhausted capacity before saving and retain supplied response ownership after file reads', async t => {
	const capacity = createPayloadCapacity({ limitBytes: 32 });
	let writes = 0;
	const { tools } = fixture(t, {
		async updateNoteWithRevision() { writes++; return { ...note }; },
	}, {
		payloadCapacity: capacity,
		async readBodyFile(file, signal, owner) { owner.reserve(33); return 'unused'; },
	});
	const failed = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile });
	assert.equal(failed.structuredContent.error.code, 'resource_capacity_exceeded');
	assert.equal(writes, 0);
	assert.equal(capacity.usedBytes, 0);

	const requestPayload = capacity.createOwner({ operation: 'read_note', stage: 'request' });
	const responsePayload = capacity.createOwner({ operation: 'read_note', stage: 'response' });
	const result = await tools.call('read_note', { id: noteId, output: 'file' }, undefined, { requestPayload, responsePayload });
	assert.equal(result.isError, false);
	assert.equal(capacity.usedBytes, 4 * Math.ceil(Buffer.byteLength(note.body) / 3));
	responsePayload.release();
	requestPayload.release();
	assert.equal(capacity.usedBytes, 0);
});


test('a two-megabyte export, file edit, guarded save, and re-export preserve exact bytes with shared accounting', async t => {
	const payloadCapacity = createPayloadCapacity();
	const storedCapacity = createPayloadCapacity({ limitBytes: defaultRetainedExportBytes });
	const store = createNoteFileResources({ payloadCapacity, storedCapacity });
	const owners = [];
	t.after(() => { for (const owner of owners) owner.release(); store.close(); });
	const originalBody = '\uFEFF# Transfer 🔧\r\nMARKER: before\r\n' + 'café 🌿\r\n'.repeat(175000);
	let saved = { ...note, body: originalBody };
	let editedBytes;
	let response;
	let requestDestroyed = false;
	let downloads = 0;
	let writes = 0;

	// Exercise the real HTTPS reader and DNS checks with a local Node transport, including split UTF-8 bytes.
	const readBodyFile = createNoteBodyFileReader({
		lookup(host, options, callback) {
			assert.equal(host, 'files.example.test');
			assert.deepEqual(options, { all: true, verbatim: true });
			queueMicrotask(() => callback(null, [{ address: '93.184.216.34', family: 4 }]));
		},
		request(url, options, callback) {
			downloads++;
			assert.equal(url.protocol, 'https:');
			const request = new EventEmitter();
			request.destroy = () => { requestDestroyed = true; };
			request.end = () => options.lookup(url.hostname, { all: true }, (error, addresses) => {
				if (error) { request.emit('error', error); return; }
				assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
				response = Readable.from([
					editedBytes.subarray(0, 1), editedBytes.subarray(1, 17),
					editedBytes.subarray(17, 100003), editedBytes.subarray(100003),
				]);
				response.statusCode = 200;
				callback(response);
			});
			return request;
		},
	});
	const tools = createTools({
		async readNoteWithRevision(id) { assert.equal(id, noteId); return { ...saved }; },
		async updateNoteWithRevision(id, changes) {
			assert.equal(id, noteId);
			assert.equal(changes.base_revision_id, saved.revision_id, 'the exported native revision guards the save');
			assert.deepEqual(Buffer.from(changes.body, 'utf8'), editedBytes);
			assert.equal(payloadCapacity.usedBytes, editedBytes.length, 'downloaded bytes stay charged through the native save');
			writes++;
			saved = { ...saved, body: changes.body, revision_id: nextRevisionId, previous_revision_id: saved.revision_id, changed: true };
			return { ...saved };
		},
	}, { allowWrites: true, payloadCapacity, noteFileResources: store, readBodyFile });

	// Read the exported file as a client, make one marker edit, and release its response storage.
	const initialResponse = payloadCapacity.createOwner({ operation: 'read_note', stage: 'response' });
	owners.push(initialResponse);
	const initial = await tools.call('read_note', { id: noteId, output: 'file' }, undefined, { responsePayload: initialResponse });
	assert.equal(initial.isError, false);
	const originalBytes = Buffer.from(initial.content[1].resource.blob, 'base64');
	assert.ok(originalBytes.length > 2_000_000 && originalBytes.length < 2_200_000);
	assert.deepEqual(originalBytes, Buffer.from(originalBody, 'utf8'));
	assert.equal(payloadCapacity.usedBytes, 4 * Math.ceil(originalBytes.length / 3));
	editedBytes = Buffer.from(originalBytes.toString('utf8').replace('MARKER: before', 'MARKER: after'), 'utf8');
	initialResponse.release();
	assert.equal(payloadCapacity.usedBytes, 0);
	assert.equal(storedCapacity.usedBytes, originalBytes.length);

	const updated = await tools.call('update_note', {
		id: noteId, base_revision_id: initial.structuredContent.revision_id, body_file: bodyFile,
	});
	assert.equal(updated.isError, false);
	assert.equal(updated.structuredContent.revision_id, nextRevisionId);
	assert.equal(updated.structuredContent.body_size_bytes, editedBytes.length);
	assert.equal(updated.structuredContent.body_sha256, createHash('sha256').update(editedBytes).digest('hex'));
	assert.equal(downloads, 1);
	assert.equal(writes, 1);
	assert.equal(requestDestroyed, true);
	assert.equal(response.destroyed, true);
	assert.equal(payloadCapacity.usedBytes, 0, 'direct update cleanup releases its request owner');

	// The committed revision exports the edited bytes, while the earlier URI keeps its original snapshot.
	const finalResponse = payloadCapacity.createOwner({ operation: 'read_note', stage: 'response' });
	owners.push(finalResponse);
	const final = await tools.call('read_note', { id: noteId, output: 'file' }, undefined, { responsePayload: finalResponse });
	assert.equal(final.isError, false);
	assert.equal(final.structuredContent.revision_id, nextRevisionId);
	assert.deepEqual(Buffer.from(final.content[1].resource.blob, 'base64'), editedBytes);
	assert.equal(final.structuredContent.file.size, editedBytes.length);
	assert.equal(final.structuredContent.file.sha256, createHash('sha256').update(editedBytes).digest('hex'));
	assert.equal(payloadCapacity.usedBytes, 4 * Math.ceil(editedBytes.length / 3));
	finalResponse.release();
	assert.deepEqual(Buffer.from(store.read(initial.structuredContent.file.uri).contents[0].blob, 'base64'), originalBytes);
	assert.equal(payloadCapacity.usedBytes, 0);
	assert.equal(storedCapacity.usedBytes, originalBytes.length + editedBytes.length);
	store.close();
	assert.equal(storedCapacity.usedBytes, 0);
});
