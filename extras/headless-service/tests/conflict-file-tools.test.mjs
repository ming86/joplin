import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../src/errors.mjs';
import { registerConflictTools } from '../src/mcp/conflict-tools.mjs';
import { createNoteFileResources } from '../src/mcp/note-file-resources.mjs';
import { createTools } from '../src/mcp/tools.mjs';

const conflictId = 'b'.repeat(32);
const originalId = 'c'.repeat(32);

function snapshot(id, values = {}) {
	return {
		id,
		title: id === conflictId ? 'Conflict copy' : 'Original note',
		body: id === conflictId ? 'Conflict 😀 café' : '<p>Original 雪</p>',
		parent_id: 'a'.repeat(32),
		markup_language: id === conflictId ? 1 : 2,
		updated_time: 123,
		...values,
	};
}

function available(id, values) {
	return { id, status: 'available', note: snapshot(id, values) };
}

function registeredReadConflict(service, getFileResources) {
	const tools = new Map();
	registerConflictTools((name, description, inputSchema, run) => {
		tools.set(name, { description, inputSchema, run });
	}, service, { getFileResources });
	return tools.get('read_conflict');
}

test('file output preserves unavailable sides and returns metadata without empty resource blocks', async () => {
	let exportsRequested = 0;
	const readConflict = registeredReadConflict({
		async readConflict() {
			return {
				accountId: 'alice',
				conflict: { id: conflictId, status: 'missing' },
				original: { id: null, status: 'unlinked' },
			};
		},
	}, () => {
		exportsRequested++;
		return createNoteFileResources();
	});

	const result = await readConflict.run({ id: conflictId, output: 'file' });
	assert.deepEqual(result.structuredContent, {
		accountId: 'alice',
		conflict: { id: conflictId, status: 'missing' },
		original: { id: null, status: 'unlinked' },
	});
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].type, 'text');
	assert.equal(exportsRequested, 0);
});

test('metadata and file outputs preserve exact captured bodies without fabricating revisions', async () => {
	const calls = [];
	const store = createNoteFileResources();
	let storeRequests = 0;
	const conflictBody = 'Conflict 😀 café\r\nSecond\nThird\rFourth\n';
	const originalBody = '<p>Original 雪</p>\r\nOriginal\n';
	const readConflict = registeredReadConflict({
		async readConflict(input) {
			calls.push(input);
			return {
				accountId: 'alice',
				conflict: available(conflictId, { body: conflictBody }),
				original: available(originalId, { body: originalBody }),
			};
		},
	}, () => {
		storeRequests++;
		return store;
	});
	const metadata = await readConflict.run({ id: conflictId, output: 'metadata' });
	assert.equal(metadata.conflict.note.body, undefined);
	assert.equal(metadata.conflict.note.body_length, conflictBody.length);
	assert.equal(metadata.conflict.note.body_size_bytes, Buffer.byteLength(conflictBody, 'utf8'));
	assert.equal(metadata.conflict.note.body_sha256, createHash('sha256').update(conflictBody, 'utf8').digest('hex'));
	assert.equal(metadata.conflict.note.body_total_line_count, 5);
	assert.equal(metadata.original.note.body, undefined);
	assert.equal(metadata.original.note.body_length, originalBody.length);
	assert.equal(metadata.original.note.body_size_bytes, Buffer.byteLength(originalBody, 'utf8'));
	assert.equal(metadata.original.note.body_sha256, createHash('sha256').update(originalBody, 'utf8').digest('hex'));
	assert.equal(metadata.original.note.body_total_line_count, 3);
	assert.equal(metadata.conflict.note.body_offset, undefined);
	assert.equal(metadata.original.note.nextOffset, undefined);
	assert.equal(metadata.conflict.note.revision_id, undefined);
	assert.equal(metadata.original.note.revision_id, undefined);
	assert.equal(metadata.conflict.note.title, 'Conflict copy');
	assert.equal(metadata.original.note.markup_language, 2);
	assert.deepEqual(store.list(), []);
	assert.equal(storeRequests, 0);

	const result = await readConflict.run({ id: conflictId, output: 'file' });
	assert.equal(storeRequests, 2);
	for (const [sideName, side, body, mimeType, extension, totalLines] of [
		['conflict', result.structuredContent.conflict, conflictBody, 'text/markdown; charset=utf-8', 'md', 5],
		['original', result.structuredContent.original, originalBody, 'text/html; charset=utf-8', 'html', 3],
	]) {
		assert.equal(side.note.body, undefined);
		assert.equal(side.note.body_total_line_count, totalLines);
		assert.equal(side.note.body_offset, undefined);
		assert.equal(side.note.nextOffset, undefined);
		assert.equal(side.note.revision_id, undefined);
		assert.equal(side.note.file.filename, `${sideName}-${side.id}.${extension}`);
		assert.equal(side.note.file.mime_type, mimeType);
		assert.equal(side.note.file.size, Buffer.byteLength(body, 'utf8'));
		assert.equal(side.note.file.sha256, createHash('sha256').update(body, 'utf8').digest('hex'));
	}
	assert.equal(result.content.length, 3);
	assert.deepEqual(result.content.map(block => block.type), ['text', 'resource', 'resource']);
	const textMetadata = JSON.parse(result.content[0].text);
	assert.equal(textMetadata.conflict.note.body, undefined);
	assert.equal(textMetadata.original.note.body, undefined);
	assert.ok(!result.content[0].text.includes(Buffer.from(conflictBody).toString('base64')));
	assert.deepEqual(result.content.slice(1).map(block => Buffer.from(block.resource.blob, 'base64').toString('utf8')), [conflictBody, originalBody]);
	assert.deepEqual(calls, [{ id: conflictId }, { id: conflictId }]);
	store.close();
});

test('file and metadata output reject every slicing selector before reading the conflict', async () => {
	let reads = 0;
	const readConflict = registeredReadConflict({
		async readConflict() {
			reads++;
			return { conflict: available(conflictId), original: { id: null, status: 'unlinked' } };
		},
	}, () => createNoteFileResources());

	for (const output of ['file', 'metadata']) {
		for (const selector of ['offset', 'max_chars']) {
			await assert.rejects(readConflict.run({ id: conflictId, output, [selector]: 0 }), error => {
				assert.ok(error instanceof ServiceError);
				assert.equal(error.code, 'note_file_slice_conflict');
				return true;
			});
		}
	}
	assert.equal(reads, 0);
});

test('read_conflict description keeps read_note as the source of update revisions', () => {
	const tool = registeredReadConflict({ readConflict() {} });
	assert.match(tool.description, /output=metadata when the body size is unknown/);
	assert.match(tool.description, /output=file to read a large body/);
	assert.match(tool.description, /call read_note.*current revision_id as base_revision_id to update_note/);
});

test('file resource results retain the createTools account projection', async () => {
	const store = createNoteFileResources();
	const tools = createTools({
		async status() { return { accountEmail: 'alice@example.com' }; },
		async readConflict() {
			return {
				accountId: 'alice',
				conflict: available(conflictId),
				original: { id: null, status: 'unlinked' },
			};
		},
	}, { noteFileResources: store });

	const result = await tools.call('read_conflict', { id: conflictId, output: 'file' });
	assert.equal(result.isError, false);
	assert.equal(result.structuredContent.accountId, undefined);
	assert.equal(result.structuredContent.accountEmail, 'alice@example.com');
	assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
	assert.equal(result.content.filter(block => block.type === 'resource').length, 1);
	store.close();
});
