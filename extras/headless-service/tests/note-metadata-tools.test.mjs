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
				todo_completed: 0,
				revision_id: revisionId,
				previous_revision_id: null,
				changed: false,
				updated_time: 10,
			};
		},
		async status() { return { accountEmail: 'reader@example.test' }; },
	};
	const noteFileResources = {
		exportNote() {
			exports++;
			throw new Error('metadata reads must not export note files');
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
		const metadata = success.anyOf.find(branch => branch.required.includes('body_size_bytes'));
		assert.ok(metadata);
		for (const required of ['body_length', 'body_size_bytes', 'body_sha256']) assert.ok(metadata.required.includes(required), required);
		assert.equal(success.properties.body_size_bytes.type, 'integer');
		assert.equal(success.properties.body_sha256.pattern, '^[a-f0-9]{64}$');
		const excluded = metadata.not.anyOf.flatMap(branch => branch.required);
		assert.deepEqual(excluded, ['body', 'file']);
	}
});
