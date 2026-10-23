import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../src/errors.mjs';
import { createRevisionClient } from '../src/revision-client.mjs';
import { createRevisionService } from '../src/revisions.mjs';
import { registerRevisionTools } from '../src/mcp/revision-tools.mjs';

const noteId = 'a'.repeat(32);
const notebookId = 'b'.repeat(32);
const rev1 = 'c'.repeat(32);
const rev2 = 'd'.repeat(32);
const note = {
	id: noteId,
	parent_id: notebookId,
	title: 'Title',
	body: 'Body',
	created_time: 1,
	updated_time: 2,
	is_todo: 0,
	todo_due: -4321,
	todo_completed: 0,
	source: 'mobile-import',
	source_application: 'net.example.mobile',
	source_url: 'https://example.test/source',
	markup_language: 1,
	encryption_applied: 0,
	deleted_time: 0,
	is_locked: 0,
	revision_id: rev2,
};

test('revision client sends only fixed flat headless actions and validates native results', async () => {
	const calls = [];
	const responses = [
		{ ...note },
		{ ...note, previous_revision_id: rev1, changed: true },
		{ items: [{ revision_id: rev1, captured_time: 3, parent_revision_id: null }], hasMore: false },
		{ note_id: noteId, revision_id: rev1, captured_time: 3, title: 'Old', body: 'old', metadata: { parent_id: notebookId, is_todo: 1, todo_due: 0, source: 'mobile-import', source_application: 'net.example.mobile', source_url: 'https://example.test/source' } },
		{ note_id: noteId, from_revision_id: rev1, to_revision_id: rev2, to_current: true, title_diff: '@@ title @@', body_diff: '@@ body @@', metadata_changes: [{ field: 'parent_id', from: { present: true, value: notebookId }, to: { present: false } }] },
	];
	const client = createRevisionClient(async (...args) => { calls.push(args); return responses.shift(); });
	const signal = new AbortController().signal;
	const current = await client.readNoteWithRevision(noteId, signal);
	assert.equal(current.revision_id, rev2);
	assert.equal(current.todo_due, -4321);
	assert.equal(current.source, 'mobile-import');
	assert.equal(current.source_application, 'net.example.mobile');
	assert.equal(current.source_url, 'https://example.test/source');
	assert.equal((await client.updateNoteWithRevision(noteId, {
		base_revision_id: rev1,
		append: '!',
		is_todo: true,
		todo_due: -1,
		source_url: '',
	}, signal)).changed, true);
	assert.deepEqual(await client.listNoteRevisions({ note_id: noteId, page: 2, limit: 3 }, signal), {
		items: [{ revision_id: rev1, captured_time: 3, parent_revision_id: null }], hasMore: false,
	});
	const historical = await client.readNoteRevision({ note_id: noteId, revision_id: rev1 }, signal);
	assert.equal(historical.body, 'old');
	assert.deepEqual(historical.metadata, {
		parent_id: notebookId,
		is_todo: 1,
		todo_due: 0,
		source: 'mobile-import',
		source_application: 'net.example.mobile',
		source_url: 'https://example.test/source',
	});
	const comparison = await client.compareNoteRevisions({ note_id: noteId, from_revision_id: rev1 }, signal);
	assert.equal(comparison.to_revision_id, rev2);
	assert.equal(comparison.to_current, true);

	assert.deepEqual(calls.map(call => call[3]), [
		{ action: 'readNote', id: noteId },
		{ action: 'updateNote', id: noteId, base_revision_id: rev1, changes: { append: '!', is_todo: true, todo_due: -1, source_url: '' } },
		{ action: 'listNoteRevisions', note_id: noteId, page: 2, limit: 3 },
		{ action: 'readNoteRevision', note_id: noteId, revision_id: rev1 },
		{ action: 'compareNoteRevisions', note_id: noteId, from_revision_id: rev1 },
	]);
	assert.ok(calls.every(call => call[0] === 'services/headless' && call[2] === 'POST' && call[4] === signal));
	assert.deepEqual(calls.map(call => call[5]), [
		{ writeOperation: true }, { writeOperation: true }, { writeOperation: false }, { writeOperation: false }, { writeOperation: false },
	]);
});

test('revision client requires a base revision and preserves safe native failures without retry', async () => {
	let calls = 0;
	const client = createRevisionClient(async () => {
		calls++;
		return { error: { code: 'note_conflict', message: 'private native detail', applied: false } };
	});
	await assert.rejects(client.updateNoteWithRevision(noteId, { body: 'new' }), { code: 'base_revision_required' });
	await assert.rejects(client.updateNoteWithRevision(noteId, { base_revision_id: rev1, body: 'new' }), error => {
		assert.equal(error.code, 'note_conflict');
		assert.equal(error.outcomeUnknown, false);
		assert.ok(!error.message.includes('private native detail'));
		return true;
	});
	assert.equal(calls, 1);

	const malformedWrite = createRevisionClient(async () => ({ id: noteId, title: 'bad response' }));
	await assert.rejects(malformedWrite.updateNoteWithRevision(noteId, { base_revision_id: rev1, body: 'new' }), error => {
		assert.equal(error.code, 'write_outcome_unknown');
		assert.equal(error.outcomeUnknown, true);
		return true;
	});

	let invalidWriteCalls = 0;
	const invalidInput = createRevisionClient(async () => { invalidWriteCalls++; return {}; });
	for (const changes of [
		{ todo_due: 1.5 },
		{ is_todo: 1 },
		{ source: 'caller-origin' },
		{ source_application: 'caller-app' },
	]) {
		await assert.rejects(invalidInput.updateNoteWithRevision(noteId, { base_revision_id: rev1, ...changes }), error => {
			assert.ok(['invalid_note_input', 'unsupported_note_property'].includes(error.code));
			return true;
		});
	}
	assert.equal(invalidWriteCalls, 0);
});

test('revision service enriches the captured live note and forwards exact updates without sidecar reads', async () => {
	const calls = [];
	let backendCreations = 0;
	let permitted = [];
	const backend = {
		async readNoteWithRevision(id) { calls.push(['read', id]); return { ...note }; },
		async getNoteTags(id) { calls.push(['tags', id]); return [{ id: 'e'.repeat(32), title: 'Work' }]; },
		async updateNoteWithRevision(id, input) { calls.push(['update', id, structuredClone(input)]); return { ...note, ...input, revision_id: rev2, previous_revision_id: rev1, changed: true }; },
		async listNoteRevisions(input) { calls.push(['list', input]); return { items: [{ revision_id: rev1, captured_time: 3, parent_revision_id: null }], hasMore: false }; },
		async readNoteRevision(input) { calls.push(['history-read', input]); return { note_id: noteId, revision_id: rev1, captured_time: 3, title: 'Old', body: 'old', metadata: {} }; },
		async compareNoteRevisions(input) { calls.push(['compare', input]); return { note_id: noteId, from_revision_id: rev1, to_revision_id: rev2, title_diff: '', body_diff: '', metadata_changes: [] }; },
		async getNote() { throw new Error('revision writes must not use the sidecar note read'); },
	};
	const service = createRevisionService({
		backend: () => { backendCreations++; return backend; },
		permit(permission) { permitted.push(permission); },
		accountId: 'alice',
		async readableNotebookTitle(id) { assert.equal(id, notebookId); return 'Research'; },
	});
	assert.equal(backendCreations, 0, 'constructing the service leaves the backend lazy');
	const live = await service.readNoteWithRevision(noteId);
	assert.equal(backendCreations, 1, 'one backend instance is resolved for the whole live-read operation');
	assert.equal(live.accountId, 'alice');
	assert.equal(live.notebook_title, 'Research');
	assert.deepEqual(live.tags, ['Work']);

	const changes = { append: '!', notebook_id: 'f'.repeat(32), is_todo: true, todo_due: -1, todo_completed: false, source_url: '' };
	const updated = await service.updateNoteWithRevision(noteId, { base_revision_id: rev1, ...changes });
	assert.equal(backendCreations, 2);
	assert.equal(updated.revision_id, rev2);
	assert.deepEqual(calls.find(([name]) => name === 'update'), ['update', noteId, { base_revision_id: rev1, ...changes }]);
	assert.equal(calls.filter(([name]) => name === 'read').length, 1, 'update does not fetch a sidecar note');

	assert.equal((await service.listNoteRevisions({ note_id: noteId })).items[0].accountId, 'alice');
	assert.equal((await service.readNoteRevision({ note_id: noteId, revision_id: rev1 })).body, 'old');
	assert.equal((await service.compareNoteRevisions({ note_id: noteId, from_revision_id: rev1 })).accountId, 'alice');
	assert.equal(backendCreations, 5);
	assert.deepEqual(permitted, ['read', 'write', 'read', 'read', 'read']);
	assert.ok(calls.some(([name]) => name === 'history-read'));
	assert.ok(calls.some(([name]) => name === 'compare'));

	await assert.rejects(service.updateNoteWithRevision(noteId, { body: 'missing base' }), { code: 'base_revision_required' });
	await assert.rejects(service.updateNoteWithRevision(noteId, { base_revision_id: rev1, parent_id: notebookId }), { code: 'unsupported_note_property' });
	await assert.rejects(service.updateNoteWithRevision(noteId, { base_revision_id: rev1, todo_due: 1.5 }), { code: 'invalid_note_input' });
});

test('revision service leaves permission and native history failures visible', async () => {
	const service = createRevisionService({
		backend: () => ({ async readNoteWithRevision() { throw new ServiceError('note_unavailable'); } }),
		permit(permission) { if (permission === 'read') throw new ServiceError('operation_not_permitted'); },
		accountId: 'alice',
		readableNotebookTitle: async () => null,
	});
	await assert.rejects(service.readNoteWithRevision(noteId), { code: 'operation_not_permitted' });
});

test('read_note_revision MCP chunks historical text on UTF-16 boundaries and returns full bodies by default', async () => {
	const tools = new Map();
	registerRevisionTools((name, description, inputSchema, run, annotations) => tools.set(name, { description, inputSchema, run, annotations }), {
		async listNoteRevisions() { return { items: [], hasMore: false }; },
		async readNoteRevision() { return { note_id: noteId, revision_id: rev1, captured_time: 3, title: 'Old', body: 'x😀yz', metadata: { is_todo: 1 } }; },
		async compareNoteRevisions() { return {}; },
	});
	assert.deepEqual([...tools.keys()], ['list_note_revisions', 'read_note_revision', 'compare_note_revisions']);
	const run = tools.get('read_note_revision').run;
	const chunk = await run({ note_id: noteId, revision_id: rev1, offset: 2, max_chars: 1 });
	assert.equal(chunk.body, '😀');
	assert.equal(chunk.body_offset, 1);
	assert.equal(chunk.nextOffset, 3);
	assert.equal(chunk.has_more, true);
	assert.deepEqual(chunk.metadata, { is_todo: 1 });
	const full = await run({ note_id: noteId, revision_id: rev1 });
	assert.equal(full.body, 'x😀yz');
	assert.equal(full.has_more, false);
	assert.equal(tools.get('read_note_revision').annotations.readOnlyHint, true);
});
