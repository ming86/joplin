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
		{ note_id: noteId, from_revision_id: rev1, to_revision_id: rev2, to_current: true, title_diff: '@@ title @@', body_diff: '@@ body @@', from_body_total_line_count: 2, to_body_total_line_count: 4, metadata_changes: [{ field: 'parent_id', from: { present: true, value: notebookId }, to: { present: false } }] },
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
	assert.equal(comparison.from_body_total_line_count, 2);
	assert.equal(comparison.to_body_total_line_count, 4);

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

test('revision client rejects missing or invalid complete-body line counts', async () => {
	for (const counts of [
		undefined,
		{ from_body_total_line_count: 0, to_body_total_line_count: 1 },
		{ from_body_total_line_count: 1.5, to_body_total_line_count: 1 },
		{ from_body_total_line_count: 1, to_body_total_line_count: Number.MAX_SAFE_INTEGER + 1 },
	]) {
		const client = createRevisionClient(async () => ({
			note_id: noteId,
			from_revision_id: rev1,
			to_revision_id: rev2,
			to_current: false,
			title_diff: '',
			body_diff: '',
			...(counts ?? {}),
			metadata_changes: [],
		}));
		await assert.rejects(client.compareNoteRevisions({ note_id: noteId, from_revision_id: rev1 }), error => {
			assert.equal(error.code, 'invalid_backend_response');
			assert.equal(error.diagnostics.path, 'services/headless');
			assert.equal(error.diagnostics.operation, 'compareNoteRevisions');
			assert.equal(error.diagnostics.stage, 'validation');
			return true;
		});
	}
});

test('combined revision client forwards both selectors, preserves empty arrays, and accepts uncapped pages', async () => {
	const calls = [];
	const item = {
		note_id: noteId,
		revision_id: rev1,
		parent_revision_id: null,
		captured_time: -1,
		current_title: null,
		current_notebook_id: notebookId,
	};
	const client = createRevisionClient(async (...args) => {
		calls.push(args);
		const request = args[3];
		return { items: [item], page: request.page, limit: request.limit, hasMore: false };
	});
	const signal = new AbortController().signal;
	const input = {
		note_ids: [noteId],
		notebook_ids: [notebookId],
		include_descendants: false,
		since: -10,
		until: 0,
		page: 2,
		limit: 150,
	};
	assert.deepEqual(await client.listRevisions(input, signal), {
		items: [item], page: 2, limit: 150, hasMore: false,
	});
	assert.deepEqual(calls[0][3], { action: 'listRevisions', ...input });
	assert.equal(calls[0][0], 'services/headless');
	assert.equal(calls[0][2], 'POST');
	assert.equal(calls[0][4], signal);
	assert.deepEqual(calls[0][5], { writeOperation: false });

	await client.listRevisions({ note_ids: [], notebook_ids: [] });
	assert.deepEqual(calls[1][3], {
		action: 'listRevisions', note_ids: [], notebook_ids: [], page: 1, limit: 20,
	});
	await client.listRevisions();
	assert.deepEqual(calls[2][3], { action: 'listRevisions', page: 1, limit: 20 });
	const invalidCalls = [];
	const nativeValidation = createRevisionClient(async (...args) => {
		invalidCalls.push(args[3]);
		return { error: { code: 'revision_invalid_request', applied: false } };
	});
	await assert.rejects(nativeValidation.listRevisions({ limit: null }), { code: 'revision_invalid_request' });
	assert.deepEqual(invalidCalls[0], { action: 'listRevisions', limit: null, page: 1 });
});

test('combined revision client validates malformed native rows', async () => {
	const malformed = createRevisionClient(async () => ({
		items: [{
			note_id: noteId,
			revision_id: rev1,
			parent_revision_id: null,
			captured_time: 1.5,
			current_title: 'Title',
			current_notebook_id: null,
		}],
		page: 1,
		limit: 20,
		hasMore: false,
	}));
	await assert.rejects(malformed.listRevisions(), error => {
		assert.equal(error.code, 'invalid_backend_response');
		assert.equal(error.diagnostics.path, 'services/headless');
		assert.equal(error.diagnostics.operation, 'listRevisions');
		assert.equal(error.diagnostics.stage, 'validation');
		return true;
	});
});

test('revision read validators attach action context to malformed backend values', async () => {
	const malformedCases = [
		['listNoteRevisions', () => createRevisionClient(async () => ({ items: [{}], hasMore: false })).listNoteRevisions({ note_id: noteId })],
		['readNoteRevision', () => createRevisionClient(async () => ({})).readNoteRevision({ note_id: noteId, revision_id: rev1 })],
		['compareNoteRevisions', () => createRevisionClient(async () => ({})).compareNoteRevisions({ note_id: noteId, from_revision_id: rev1 })],
	];
	for (const [operation, invoke] of malformedCases) {
		await assert.rejects(invoke(), error => {
			assert.equal(error.code, 'invalid_backend_response');
			assert.equal(error.diagnostics.method, 'POST');
			assert.equal(error.diagnostics.path, 'services/headless');
			assert.equal(error.diagnostics.operation, operation);
			assert.equal(error.diagnostics.stage, 'validation');
			return true;
		});
	}
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
		assert.equal(error.diagnostics.method, 'POST');
		assert.equal(error.diagnostics.path, 'services/headless');
		assert.equal(error.diagnostics.operation, 'updateNote');
		assert.equal(error.diagnostics.stage, 'validation');
		return true;
	});
	assert.equal(calls, 1);

	const unknownEnvelope = createRevisionClient(async () => ({ error: {
		code: 'unexpected_native_error', message: 'private native detail', applied: false,
	} }));
	await assert.rejects(unknownEnvelope.updateNoteWithRevision(noteId, { base_revision_id: rev1, body: 'new' }), error => {
		assert.equal(error.code, 'write_outcome_unknown');
		assert.equal(error.outcomeUnknown, true);
		assert.ok(!error.message.includes('private native detail'));
		assert.equal(error.diagnostics.operation, 'updateNote');
		assert.equal(error.diagnostics.stage, 'validation');
		return true;
	});

	const malformedWrite = createRevisionClient(async () => ({ id: noteId, title: 'bad response' }));
	await assert.rejects(malformedWrite.updateNoteWithRevision(noteId, { base_revision_id: rev1, body: 'new' }), error => {
		assert.equal(error.code, 'write_outcome_unknown');
		assert.equal(error.outcomeUnknown, true);
		assert.equal(error.cause.code, 'invalid_backend_response');
		assert.equal(error.diagnostics.path, 'services/headless');
		assert.equal(error.diagnostics.operation, 'updateNote');
		assert.equal(error.diagnostics.stage, 'validation');
		return true;
	});
	const malformedCapture = createRevisionClient(async () => ({ id: noteId, title: 'bad response' }));
	await assert.rejects(malformedCapture.readNoteWithRevision(noteId), error => {
		assert.equal(error.code, 'write_outcome_unknown');
		assert.equal(error.outcomeUnknown, true);
		assert.equal(error.cause.code, 'invalid_backend_response');
		assert.equal(error.diagnostics.path, 'services/headless');
		assert.equal(error.diagnostics.operation, 'readNote');
		assert.equal(error.diagnostics.stage, 'validation');
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
		async compareNoteRevisions(input) { calls.push(['compare', input]); return { note_id: noteId, from_revision_id: rev1, to_revision_id: rev2, to_current: false, title_diff: '', body_diff: '', from_body_total_line_count: 1, to_body_total_line_count: 1, metadata_changes: [] }; },
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

test('combined revision service uses read permission, preserves empty selectors, and adds account identity only at the root', async () => {
	const calls = [];
	const signals = [];
	const permitted = [];
	const row = {
		note_id: noteId,
		revision_id: rev1,
		parent_revision_id: null,
		captured_time: 5,
		current_title: 'Current title',
		current_notebook_id: notebookId,
	};
	const service = createRevisionService({
		backend: () => ({
			async listRevisions(input, signal) {
				calls.push(input);
				signals.push(signal);
				return { items: [row], page: input.page, limit: input.limit, hasMore: true };
			},
		}),
		permit(permission) { permitted.push(permission); },
		accountId: 'alice',
		readableNotebookTitle: async () => null,
	});
	const signal = new AbortController().signal;
	const result = await service.listRevisions({ note_ids: [], notebook_ids: [], page: 3, limit: 125 }, signal);
	assert.deepEqual(calls, [{ note_ids: [], notebook_ids: [], page: 3, limit: 125 }]);
	assert.equal(signals[0], signal);
	assert.deepEqual(permitted, ['read']);
	assert.deepEqual(result, { accountId: 'alice', items: [row], page: 3, limit: 125, hasMore: true });
	assert.equal(Object.hasOwn(result.items[0], 'accountId'), false);
	await assert.rejects(service.listRevisions({ limit: null }), { code: 'invalid_pagination' });
	await assert.rejects(service.listRevisions({ page: Number.MAX_SAFE_INTEGER, limit: 2 }), { code: 'invalid_pagination' });
	assert.equal(calls.length, 1, 'invalid public input is rejected before calling the native client');

	await service.listRevisions();
	assert.deepEqual(calls[1], { page: 1, limit: 20 });
	assert.equal(signals[1], undefined);
});

test('read_note_revision MCP chunks historical text on UTF-16 boundaries and returns full bodies by default', async () => {
	const tools = new Map();
	registerRevisionTools((name, description, inputSchema, run, annotations) => tools.set(name, { description, inputSchema, run, annotations }), {
		async listRevisions() { return { items: [], page: 1, limit: 20, hasMore: false }; },
		async listNoteRevisions() { return { items: [], hasMore: false }; },
		async readNoteRevision() { return { note_id: noteId, revision_id: rev1, captured_time: 3, title: 'Old', body: 'x😀yz', metadata: { is_todo: 1 } }; },
		async compareNoteRevisions() { return {}; },
	});
	assert.deepEqual([...tools.keys()], ['list_revisions', 'list_note_revisions', 'read_note_revision', 'compare_note_revisions']);
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
