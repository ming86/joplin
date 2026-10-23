import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTools } from '../src/mcp/tools.mjs';

const noteId = 'a'.repeat(32);
const revisionId = 'b'.repeat(32);
const body = 'A😀é漢\r\n metadata body';

/** Build read tools with one revision snapshot and a spy for file exports. */
function fixture() {
	let reads = 0;
	let exports = 0;
	const service = {
		async readNoteWithRevision(id) {
			reads++;
			assert.equal(id, noteId);
			return {
				id: noteId,
				accountId: 'local-account',
				title: 'Metadata note',
				parent_id: 'c'.repeat(32),
				body,
				tags: ['unicode'],
				is_todo: 1,
				todo_due: -1,
				todo_completed: 0,
				source_url: 'https://example.test/source',
				source: 'native-source-id',
				source_application: 'net.example.reader',
				revision_id: revisionId,
				previous_revision_id: null,
				changed: false,
				updated_time: 10,
			};
		},
		async status() { return { accountEmail: 'reader@example.test' }; },
	};
	const noteFileResources = {
		exportNote(note) {
			exports++;
			const uri = 'joplin-note-file://snapshot/metadata-note.md';
			return {
				file: {
					uri, filename: 'metadata-note.md', mime_type: 'text/markdown; charset=utf-8',
					size: Buffer.byteLength(note.body), sha256: 'c'.repeat(64), expires_at: '2026-10-23T00:00:00.000Z',
				},
				resource: { uri, mimeType: 'text/markdown; charset=utf-8', blob: Buffer.from(note.body).toString('base64') },
			};
		},
	};
	return {
		tools: createTools(service, { noteFileResources }),
		get reads() { return reads; },
		get exports() { return exports; },
	};
}

test('metadata reads return native context and exact UTF-16 and UTF-8 body measurements', async () => {
	const context = fixture();
	const { tools } = context;
	for (const name of ['read_note', 'get_note']) {
		const result = await tools.call(name, { id: noteId, output: 'metadata' });
		assert.equal(result.isError, false);
		assert.equal(result.content.length, 1);
		const value = result.structuredContent;
		assert.equal(value.id, noteId);
		assert.equal(value.accountEmail, 'reader@example.test');
		assert.equal(Object.hasOwn(value, 'accountId'), false);
		assert.equal(value.revision_id, revisionId);
		assert.equal(value.previous_revision_id, null);
		assert.equal(value.changed, false);
		assert.equal(value.notebook_id, 'c'.repeat(32));
		assert.equal(value.notebook_title, null);
		assert.deepEqual(value.tags, ['unicode']);
		assert.equal(value.is_todo, name === 'get_note' ? 1 : true);
		assert.equal(value.todo_completed, name === 'get_note' ? 0 : false);
		assert.equal(value.todo_due, -1);
		assert.equal(value.source_url, 'https://example.test/source');
		assert.equal(value.source, 'native-source-id');
		assert.equal(value.source_application, 'net.example.reader');
		assert.equal(value.body_length, body.length);
		assert.equal(value.body_size_bytes, Buffer.byteLength(body, 'utf8'));
		assert.equal(value.body_sha256, createHash('sha256').update(body, 'utf8').digest('hex'));
		for (const field of ['body', 'file', 'body_offset', 'body_returned_chars', 'has_more', 'offset', 'nextOffset', 'totalLength', 'offsetUnit']) {
			assert.equal(Object.hasOwn(value, field), false, field);
		}
		assert.equal(result.content[0].text.includes(body), false);
	}
	assert.equal(context.reads, 2);
	assert.equal(context.exports, 0);
});

test('read and get note project pre-1970 due dates and source metadata in every output mode', async () => {
	const context = fixture();
	const { tools } = context;
	for (const name of ['read_note', 'get_note']) {
		for (const output of ['inline', 'file', 'metadata']) {
			const result = await tools.call(name, { id: noteId, output });
			assert.equal(result.isError, false);
			const value = result.structuredContent;
			assert.equal(value.todo_due, -1);
			assert.equal(value.source_url, 'https://example.test/source');
			assert.equal(value.source, 'native-source-id');
			assert.equal(value.source_application, 'net.example.reader');
			assert.equal(value.is_todo, name === 'get_note' ? 1 : true);
			assert.equal(value.todo_completed, name === 'get_note' ? 0 : false);
			if (output === 'inline') assert.equal(value.body, body);
			else assert.equal(Object.hasOwn(value, 'body'), false);
			if (output === 'file') assert.ok(value.file);
		}
	}
	assert.equal(context.reads, 6);
	assert.equal(context.exports, 2);
});

test('metadata reads reject all slicing selectors before reading a note', async () => {
	const context = fixture();
	const { tools } = context;
	for (const name of ['read_note', 'get_note']) {
		for (const selector of [{ offset: 0 }, { max_chars: 0 }, { length: 1 }]) {
			const result = await tools.call(name, { id: noteId, output: 'metadata', ...selector });
			assert.equal(result.isError, true);
			assert.equal(result.structuredContent.error.code, 'note_file_slice_conflict');
			assert.match(result.structuredContent.error.message, /omit offset, max_chars and length/);
		}
	}
	assert.equal(context.reads, 0);
});

test('read tool schemas describe metadata as a distinct body-free result mode', async () => {
	const { tools } = fixture();
	for (const name of ['read_note', 'get_note']) {
		const definition = tools.list().find(tool => tool.name === name);
		assert.deepEqual(definition.inputSchema.properties.output.enum, ['inline', 'file', 'metadata']);
		assert.match(definition.description, /output=metadata.*size is unknown/i);
		assert.match(definition.description, /output=file.*large note.*full rewrite.*model context/i);
		assert.match(definition.description, /partial edits for small changes/i);

		const success = definition.outputSchema.anyOf[0];
		for (const field of ['todo_due', 'source_url', 'source', 'source_application']) {
			assert.ok(success.properties[field], field);
			assert.ok(success.required.includes(field), `${name} requires ${field}`);
		}
		assert.equal(success.properties.todo_due.type, 'integer');
		assert.equal(Object.hasOwn(success.properties.todo_due, 'minimum'), false);
		assert.match(success.properties.todo_due.description, /Unix epoch milliseconds.*negative values.*0 means no due date/);
		assert.equal(success.properties.source_url.type, 'string');
		assert.match(success.properties.source_url.description, /empty string means no source URL/);
		assert.equal(success.properties.source.type, 'string');
		assert.equal(success.properties.source_application.type, 'string');
		const metadata = success.anyOf.find(branch => branch.required.includes('body_size_bytes'));
		assert.ok(metadata);
		for (const required of ['body_length', 'body_size_bytes', 'body_sha256']) assert.ok(metadata.required.includes(required), required);
		assert.equal(success.properties.body_size_bytes.type, 'integer');
		assert.equal(success.properties.body_sha256.pattern, '^[a-f0-9]{64}$');
		const excluded = metadata.not.anyOf.flatMap(branch => branch.required);
		assert.deepEqual(excluded, ['body', 'file']);
	}
});
