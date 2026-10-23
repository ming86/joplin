import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/mcp/tools.mjs';
import { ServiceError } from '../src/errors.mjs';

const noteId = 'a'.repeat(32);
const notebookId = 'b'.repeat(32);
const bodyFile = { download_url: 'https://files.example.test/generated?secret=hidden', file_id: 'generated-note' };

/** Build a writable catalog with a small fake create service. */
function fixture(t, overrides = {}, options = {}) {
	const service = {
		async createNote(args) {
			return { id: noteId, title: args.title, notebook_id: args.notebook_id ?? args.parentId ?? null };
		},
		...overrides,
	};
	return createTools(service, { allowWrites: true, ...options });
}

test('create_note accepts a large UTF-8 file body and returns metadata only', async t => {
	const generatedBody = '\uFEFF# Generated 🧪\r\n' + 'large body 🌿\n'.repeat(100000);
	const signal = new AbortController().signal;
	let saved;
	let reads = 0;
	const tools = fixture(t, {
		async createNote(args, receivedSignal) {
			assert.equal(receivedSignal, signal);
			saved = args;
			return { id: noteId, title: args.title, notebook_id: args.notebook_id };
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
	assert.match(definition.description, /response contains note metadata only/);
	assert.deepEqual(definition.inputSchema.anyOf.map(branch => branch.required), [
		['title', 'notebook_id'],
		['title', 'parentId'],
	]);
	for (const branch of definition.inputSchema.anyOf) {
		assert.deepEqual(Object.keys(branch.properties), Object.keys(definition.inputSchema.properties));
	}

	const result = await tools.call('create_note', {
		title: 'Generated note', notebook_id: notebookId, is_todo: true, body_file: bodyFile,
	}, signal);
	assert.equal(reads, 1);
	assert.deepEqual(saved, {
		title: 'Generated note', notebook_id: notebookId, is_todo: true, body: generatedBody,
	});
	assert.deepEqual(result.structuredContent, { id: noteId, title: 'Generated note', notebook_id: notebookId });
	assert.equal(result.content[0].text.includes(generatedBody), false);
});

test('create_note rejects body and body_file together, including an empty inline body, before reading or writing', async t => {
	let reads = 0;
	let writes = 0;
	const tools = fixture(t, {
		async createNote() { writes++; throw new Error('should not create'); },
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
		async createNote() { writes++; throw new Error('should not create'); },
	}, { async readBodyFile() { throw new ServiceError('note_file_invalid_utf8'); } });
	const result = await tools.call('create_note', { title: 'Invalid', notebook_id: notebookId, body_file: bodyFile });
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.error.code, 'note_file_invalid_utf8');
	assert.match(result.structuredContent.error.message, /valid UTF-8/);
	assert.equal(writes, 0);
});

test('inline and body-free create_note payloads retain their existing fields and compact replies', async t => {
	const calls = [];
	const tools = fixture(t, {
		async createNote(args) {
			calls.push(args);
			return { id: noteId, title: args.title, parent_id: args.notebook_id ?? args.parentId };
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
	assert.deepEqual(inline.structuredContent, { id: noteId, title: 'Inline', notebook_id: notebookId });
	assert.deepEqual(metadataOnly.structuredContent, { id: noteId, title: 'Empty', notebook_id: notebookId });
});
