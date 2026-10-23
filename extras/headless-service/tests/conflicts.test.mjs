import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRegistry, ServiceError } from '../index.mjs';
import { createConflictClient } from '../src/conflict-client.mjs';
import { createConflictService } from '../src/conflicts.mjs';
import { createTools } from '../src/mcp/tools.mjs';
import { createMcpSession } from '../mcp.mjs';
import { account, backend as baseBackend, folderId, note } from './fixtures.mjs';

const conflictId = 'b'.repeat(32);
const originalId = 'c'.repeat(32);
const unavailableId = 'd'.repeat(32);
const conflictSummary = {
	id: conflictId,
	title: 'Conflict copy',
	conflict_original_id: originalId,
	created_time: 100,
	updated_time: 200,
};
const snapshot = (id, values = {}) => ({
	id,
	parent_id: id === conflictId ? '' : folderId,
	title: id === conflictId ? 'Conflict copy' : 'Original note',
	body: 'current body',
	created_time: 100,
	updated_time: 200,
	is_todo: 0,
	todo_completed: 0,
	markup_language: 1,
	is_conflict: id === conflictId ? 1 : 0,
	conflict_original_id: id === conflictId ? originalId : '',
	...values,
});
const available = (id, values = {}) => ({ id, status: 'available', note: snapshot(id, values) });

test('conflict client sends fixed read-only actions and validates their fields', async () => {
	const calls = [];
	const responses = [
		{ items: [conflictSummary], hasMore: true },
		{ conflict: available(conflictId), original: available(originalId) },
	];
	const client = createConflictClient(async (...args) => { calls.push(args); return responses.shift(); });
	const signal = new AbortController().signal;
	assert.deepEqual(await client.listConflicts({ page: 2, limit: 3 }, signal), { items: [conflictSummary], hasMore: true });
	assert.deepEqual(await client.readConflict({ id: conflictId }, signal), {
		conflict: available(conflictId), original: available(originalId),
	});
	assert.deepEqual(calls.map(call => call[3]), [
		{ action: 'listConflicts', page: 2, limit: 3 },
		{ action: 'readConflict', id: conflictId },
	]);
	assert.ok(calls.every(call => call[0] === 'services/headless' && call[1] && call[2] === 'POST'
		&& call[4] === signal && call[5].writeOperation === false));

	await assert.rejects(client.listConflicts({ extra: true }), { code: 'invalid_conflict_input' });
	await assert.rejects(client.listConflicts({ page: 1, limit: 101 }), { code: 'invalid_conflict_input' });
	await assert.rejects(client.readConflict({ id: 'invalid' }), { code: 'invalid_conflict_input' });
	await assert.rejects(client.readConflict({ id: conflictId, extra: true }), { code: 'invalid_conflict_input' });
	});

test('conflict client preserves native empty relation fields', async () => {
	const unlinkedSummary = { ...conflictSummary, id: unavailableId, conflict_original_id: '' };
	const client = createConflictClient(async (_path, _query, _method, payload) => payload.action === 'listConflicts'
		? { items: [unlinkedSummary], hasMore: false }
		: {
			conflict: available(conflictId),
			original: available(originalId),
		});

	const listed = await client.listConflicts();
	assert.deepEqual(listed.items, [unlinkedSummary]);
	const result = await client.readConflict({ id: conflictId });
	assert.equal(result.conflict.note.parent_id, '');
	assert.equal(result.original.note.conflict_original_id, '');
	const unlinkedClient = createConflictClient(async () => ({
		conflict: available(conflictId),
		original: { id: null, status: 'unlinked' },
	}));
	assert.deepEqual((await unlinkedClient.readConflict({ id: conflictId })).original, { id: null, status: 'unlinked' });
	const invalidSideId = createConflictClient(async () => ({
		conflict: { id: '', status: 'unlinked' },
		original: { id: null, status: 'unlinked' },
	}));
	await assert.rejects(invalidSideId.readConflict({ id: conflictId }), { code: 'invalid_backend_response' });
});

test('conflict client retains unavailable states, strips unavailable content, and rejects malformed results', async () => {
	const client = createConflictClient(async () => ({
		conflict: available(conflictId),
		original: { id: unavailableId, status: 'encrypted', note: snapshot(unavailableId, { body: 'must stay hidden' }) },
	}));
	const result = await client.readConflict({ id: conflictId });
	assert.deepEqual(result.original, { id: unavailableId, status: 'encrypted' });
	assert.equal(result.conflict.note.body, 'current body');

	const missing = createConflictClient(async () => ({ error: { code: 'conflict_not_found', message: 'private detail', applied: false } }));
	await assert.rejects(missing.readConflict({ id: conflictId }), error => {
		assert.equal(error.code, 'conflict_not_found');
		assert.equal(error.outcomeUnknown, false);
		assert.ok(!error.message.includes('private detail'));
		return true;
	});
	const invalidEnvelope = createConflictClient(async () => ({ error: { code: 'conflict_not_found', message: 'x', applied: true } }));
	await assert.rejects(invalidEnvelope.readConflict({ id: conflictId }), { code: 'invalid_backend_response' });
	const malformedRow = createConflictClient(async () => ({ items: [{ ...conflictSummary, created_time: '100' }], hasMore: false }));
	await assert.rejects(malformedRow.listConflicts(), { code: 'invalid_backend_response' });
	const malformedSnapshot = createConflictClient(async () => ({
		conflict: available(conflictId, { is_conflict: true }), original: { id: originalId, status: 'missing' },
	}));
	await assert.rejects(malformedSnapshot.readConflict({ id: conflictId }), { code: 'invalid_backend_response' });
});

test('conflict service enforces read permission and keeps results account-bound', async () => {
	const calls = [];
	const backend = {
		async listConflicts(input, signal) { calls.push(['list', input, signal]); return { items: [conflictSummary], hasMore: false }; },
		async readConflict(input, signal) { calls.push(['read', input, signal]); return { conflict: available(conflictId), original: { id: null, status: 'unlinked' } }; },
	};
	const permissions = [];
	const service = createConflictService({
		backend: () => backend,
		permit(permission) { permissions.push(permission); },
		accountId: 'alice',
	});
	const signal = new AbortController().signal;
	assert.deepEqual(await service.listConflicts({ page: 2, limit: 4 }, signal), { accountId: 'alice', items: [conflictSummary], hasMore: false });
	assert.deepEqual(await service.readConflict({ id: conflictId }, signal), { accountId: 'alice', conflict: available(conflictId), original: { id: null, status: 'unlinked' } });
	assert.deepEqual(calls, [
		['list', { page: 2, limit: 4 }, signal],
		['read', { id: conflictId }, signal],
	]);
	assert.deepEqual(permissions, ['read', 'read']);
	await assert.rejects(service.readConflict({ id: 'invalid' }), { code: 'invalid_conflict_input' });

	const denied = createConflictService({ backend: () => backend, permit() { throw new ServiceError('operation_not_permitted'); }, accountId: 'alice' });
	await assert.rejects(denied.listConflicts(), { code: 'operation_not_permitted' });
});

test('read_conflict chunks each available side on UTF-16 boundaries and retains unavailable status', async () => {
	const service = {
		async listConflicts() { return { items: [conflictSummary], hasMore: false }; },
		async readConflict() {
			return {
				accountId: 'alice',
				conflict: available(conflictId, { body: 'x😀yz\r\n' }),
				original: available(originalId, { body: 'a😀bcde\n' }),
			};
		},
	};
	const tools = createTools(service, { allowWrites: false });
	const definitions = tools.list();
	for (const name of ['list_conflicts', 'read_conflict']) {
		const tool = definitions.find(item => item.name === name);
		assert.ok(tool);
		assert.equal(tool.annotations.readOnlyHint, true);
	}
	assert.ok(!definitions.some(item => item.name === 'update_note'));
	const chunk = (await tools.call('read_conflict', { id: conflictId, offset: 2, max_chars: 1 })).structuredContent;
	assert.equal(chunk.conflict.note.body, '😀');
	assert.equal(chunk.conflict.note.body_length, 7);
	assert.equal(chunk.conflict.note.body_total_line_count, 2);
	assert.equal(chunk.conflict.note.body_offset, 1);
	assert.equal(chunk.conflict.note.body_returned_chars, 2);
	assert.equal(chunk.conflict.note.has_more, true);
	assert.equal(chunk.conflict.note.nextOffset, 3);
	assert.equal(chunk.original.note.body, '😀');
	assert.equal(chunk.original.note.body_length, 8);
	assert.equal(chunk.original.note.body_total_line_count, 2);
	assert.equal(chunk.original.note.body_offset, 1);
	assert.equal(chunk.original.note.nextOffset, 3);
	assert.equal(chunk.conflict.note.revision_id, undefined);

	service.readConflict = async () => ({
		accountId: 'alice',
		conflict: available(conflictId),
		original: { id: unavailableId, status: 'locked', note: snapshot(unavailableId, { body: 'must stay hidden' }) },
	});
	const unavailable = (await tools.call('read_conflict', { id: conflictId })).structuredContent;
	assert.deepEqual(unavailable.original, { id: unavailableId, status: 'locked' });
});

test('conflict MCP errors use safe messages and list/read work as a paired read-only workflow', async () => {
	const native = baseBackend();
	let revisionReads = 0;
	native.listConflicts = async options => ({ items: [{ ...conflictSummary, page: options.page, limit: options.limit }], hasMore: false });
	native.readConflict = async ({ id }) => {
		assert.equal(id, conflictId);
		return { conflict: available(conflictId), original: available(originalId) };
	};
	native.getNote = async id => ({ ...note, id, parent_id: folderId });
	native.readNoteWithRevision = async id => { revisionReads++; return { ...note, id, revision_id: 'e'.repeat(32) }; };
	const config = account();
	const service = createAccountRegistry([config], { makeBackend: () => native }).forPrincipal('alice', 'alice');
	const session = createMcpSession(service, { stateless: true });
	try {
		const listed = (await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_conflicts', arguments: { page: 1 } } })).result;
		assert.equal(listed.isError, false);
		assert.equal(listed.structuredContent.items[0].id, conflictId);
		const inspected = (await session.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_conflict', arguments: { id: conflictId } } })).result;
		assert.equal(inspected.isError, false);
		assert.equal(inspected.structuredContent.conflict.note.body, 'current body');
		assert.equal(inspected.structuredContent.conflict.note.revision_id, undefined);
		const current = (await session.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_note', arguments: { id: conflictId } } })).result;
		assert.equal(current.structuredContent.revision_id, 'e'.repeat(32));
		assert.equal(revisionReads, 1);
	} finally {
		session.close();
	}

	const failing = createTools({
		listConflicts() { throw new ServiceError('invalid_conflict_input', false, 'private backend validation'); },
		readConflict() { throw new ServiceError('conflict_not_found', false, 'private backend details'); },
	});
	const result = await failing.call('read_conflict', { id: conflictId });
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.error.code, 'conflict_not_found');
	assert.equal(result.structuredContent.error.message, 'The requested device-local sync conflict was not found.');
	assert.ok(!JSON.stringify(result.structuredContent).includes('private backend details'));
});
