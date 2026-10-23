import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTools } from '../src/mcp/tools.mjs';
import { createNoteFileResources } from '../src/mcp/note-file-resources.mjs';
import { ServiceError } from '../src/errors.mjs';

const noteId = 'a'.repeat(32);
const revisionId = 'b'.repeat(32);
const nextRevisionId = 'c'.repeat(32);
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

test('file mode explicitly rejects every slicing selector before reading the note', async t => {
	let reads = 0;
	const { tools } = fixture(t, { async readNoteWithRevision() { reads++; return note; } });
	for (const selector of [{ offset: 0 }, { max_chars: 0 }, { length: 1 }]) {
		const result = await tools.call('read_note', { id: noteId, output: 'file', ...selector });
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent.error.code, 'note_file_slice_conflict');
		assert.match(result.structuredContent.error.message, /omit offset/);
	}
	assert.equal(reads, 0);
});

test('catalog publishes a fixed file-input object and object output variants', async t => {
	const { tools } = fixture(t);
	const update = tools.list().find(tool => tool.name === 'update_note');
	assert.deepEqual(update._meta, { 'openai/fileParams': ['body_file'] });
	assert.deepEqual(Object.keys(update.inputSchema.properties.body_file.properties), ['download_url', 'file_id', 'mime_type', 'file_name']);
	assert.deepEqual(update.inputSchema.properties.body_file.required, ['download_url', 'file_id']);
	assert.match(update.inputSchema.properties.body_file.description, /body_size_bytes and body_sha256.*edited local file byte count.*SHA-256/);
	assert.match(update.description, /File-update acknowledgments include body_length, body_size_bytes and body_sha256/);
	assert.match(update.description, /edited local file byte count.*SHA-256/);
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
		assert.equal(success.type, 'object');
		assert.equal(success.properties.file.type, 'object');
		const inline = success.anyOf.find(branch => branch.required.includes('body'));
		const file = success.anyOf.find(branch => branch.required.includes('file'));
		assert.deepEqual(inline.not, { required: ['file'] });
		assert.deepEqual(file.not, { required: ['body'] });
		const value = (await tools.call(name, { id: noteId, output: 'file' })).structuredContent;
		for (const field of [...success.required, ...file.required]) assert.ok(Object.hasOwn(value, field), field);
		for (const field of success.properties.file.required) assert.ok(Object.hasOwn(value.file, field), field);
	}
	const updateOutput = update.outputSchema.anyOf[0];
	assert.deepEqual(updateOutput.required, ['id', 'updated_time', 'revision_id', 'previous_revision_id', 'changed']);
	for (const field of ['body_length', 'body_size_bytes', 'body_sha256']) assert.ok(updateOutput.properties[field], field);
	assert.deepEqual(updateOutput.anyOf, [
		{ not: { anyOf: [{ required: ['body_length'] }, { required: ['body_size_bytes'] }, { required: ['body_sha256'] }] } },
		{ required: ['body_length', 'body_size_bytes', 'body_sha256'] },
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

test('file body update returns measurements for the saved body, not the downloaded text', async t => {
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
	}, { readBodyFile: async (file, receivedSignal) => { assert.deepEqual(file, bodyFile); assert.equal(receivedSignal, signal); return submittedBody; } });
	const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile, title: 'Edited', todo_completed: true }, signal);
	assert.deepEqual(saved, { base_revision_id: revisionId, body: submittedBody, title: 'Edited', todo_completed: true });
	assert.deepEqual(result.structuredContent, {
		id: noteId, updated_time: 20, revision_id: nextRevisionId, previous_revision_id: revisionId, changed: true,
		body_length: savedBody.length,
		body_size_bytes: Buffer.byteLength(savedBody, 'utf8'),
		body_sha256: createHash('sha256').update(savedBody, 'utf8').digest('hex'),
	});
	assert.notEqual(result.structuredContent.body_sha256, createHash('sha256').update(submittedBody, 'utf8').digest('hex'));
	assert.equal(result.content[0].text.includes('Saved complete body'), false);
});

test('file body no-op acknowledgments measure the returned unchanged saved body', async t => {
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
	});
});

test('file body updates report unknown outcome when the saved snapshot has no usable body', async t => {
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

test('body_file conflicts never download or save, while inline body precedence is retained', async t => {
	let downloads = 0;
	const saves = [];
	const { tools } = fixture(t, {
		async updateNoteWithRevision(_id, changes) { saves.push(changes); return note; },
	}, { readBodyFile: async () => { downloads++; return 'edited'; } });
	for (const conflict of [{ body: '' }, { append: '' }, { prepend: '' }, { replace_text: { find: 'a', replace: 'b' } }]) {
		const result = await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body_file: bodyFile, ...conflict });
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent.error.code, 'note_file_body_conflict');
	}
	assert.equal(downloads, 0);
	assert.equal(saves.length, 0);
	await tools.call('update_note', { id: noteId, base_revision_id: revisionId, body: 'rewrite', append: 'ignored by native backend' });
	assert.deepEqual(saves, [{ base_revision_id: revisionId, body: 'rewrite', append: 'ignored by native backend' }]);
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
