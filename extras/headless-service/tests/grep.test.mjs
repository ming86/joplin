import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRegistry } from '../index.mjs';
import { account } from './fixtures.mjs';

const notebookRoot = 'a'.repeat(32);
const notebookChild = 'b'.repeat(32);
const notebookOther = 'c'.repeat(32);
const revisionId = 'd'.repeat(32);

/** Return an eligible note record with a stable ID and native revision. */
function makeNote(id, parent_id, body, values = {}) {
	return {
		id, parent_id, body, title: `Note ${id[0]}`,
		encryption_applied: 0, deleted_time: 0, is_locked: 0,
		revision_id: revisionId,
		...values,
	};
}

/** Build the public account service over a controllable Joplin backend. */
function fixture(notes, { snapshots = new Map(), folders } = {}) {
	const ordered = [...notes.values()].sort((left, right) => left.id.localeCompare(right.id));
	const calls = { captures: [], summaryReads: 0 };
	const backend = {
		async listNoteSummaries({ page, limit }) {
			calls.summaryReads++;
			const start = (page - 1) * limit;
			return { items: ordered.slice(start, start + limit).map(({ body, ...note }) => ({ ...note })), hasMore: start + limit < ordered.length };
		},
		async listAllNotebooks() {
			return folders ?? [
				{ id: notebookRoot, title: 'Root', parent_id: null },
				{ id: notebookChild, title: 'Child', parent_id: notebookRoot },
				{ id: notebookOther, title: 'Other', parent_id: null },
			];
		},
		async getNote(id) {
			const note = notes.get(id);
			if (!note) throw Object.assign(new Error('not found'), { code: 'not_found' });
			return { ...note };
		},
		async readNoteWithRevision(id) {
			calls.captures.push(id);
			return { ...(snapshots.get(id) ?? notes.get(id)) };
		},
	};
	const service = createAccountRegistry([account()], { makeBackend: () => backend }).forPrincipal('alice', 'alice');
	return { service, calls };
}

test('grep defaults to literal line matching and returns the exact captured body with context', async () => {
	const id = '1'.repeat(32);
	const notes = new Map([[id, makeNote(id, notebookRoot, 'before\r\nneedle[0-9] needle[0-9]\r\nafter\n')]]);
	const snapshots = new Map([[id, makeNote(id, notebookRoot, 'before\r\nneedle[0-9] needle[0-9]\r\nafter\n', { revision_id: 'e'.repeat(32) })]]);
	const { service, calls } = fixture(notes, { snapshots });

	const result = await service.grepNotes({ pattern: 'NEEDLE[0-9]', case_sensitive: false, context_before: 1, context_after: 2 });
	assert.deepEqual(result, {
		accountId: 'alice', page: 1, limit: 20, hasMore: false,
		items: [{
			note_id: id,
			title: `Note ${id[0]}`,
			notebook_id: notebookRoot,
			revision_id: 'e'.repeat(32),
			line_number: 2,
			text: 'needle[0-9] needle[0-9]',
			truncated: false,
			line_length: 23,
			context_before: [{ line_number: 1, text: 'before', truncated: false, line_length: 6 }],
			context_after: [
				{ line_number: 3, text: 'after', truncated: false, line_length: 5 },
				{ line_number: 4, text: '', truncated: false, line_length: 0 },
			],
		}],
	});
	assert.deepEqual(calls.captures, [id]);
	assert.equal(calls.summaryReads, 1);
});

test('regex mode matches per line and repeated occurrences still produce one row', async () => {
	const id = '2'.repeat(32);
	const notes = new Map([[id, makeNote(id, notebookRoot, 'x\r\ncat cat\nDOG\n')]]);
	const { service, calls } = fixture(notes);

	const result = await service.grepNotes({ pattern: 'cat|dog', mode: 'regex', case_sensitive: false });
	assert.deepEqual(result.items.map(item => [item.line_number, item.text]), [[2, 'cat cat'], [3, 'DOG']]);
	assert.equal(result.items[0].revision_id, revisionId);
	assert.deepEqual(calls.captures, [id]);
	assert.equal((await service.grepNotes({ pattern: 'cat.*dog', mode: 'regex' })).items.length, 0);
	assert.deepEqual(calls.captures, [id]);
});

test('note and notebook scopes form a deduplicated union with optional descendant expansion', async () => {
	const ids = ['1', '2', '3'].map(value => value.repeat(32));
	const notes = new Map([
		[ids[0], makeNote(ids[0], notebookRoot, 'needle')],
		[ids[1], makeNote(ids[1], notebookChild, 'needle')],
		[ids[2], makeNote(ids[2], notebookOther, 'needle')],
	]);
	const { service } = fixture(notes);

	const union = await service.grepNotes({ pattern: 'needle', note_ids: [ids[2], ids[2]], notebook_ids: [notebookRoot] });
	assert.deepEqual(union.items.map(item => item.note_id), ids);
	const direct = await service.grepNotes({ pattern: 'needle', note_ids: [], notebook_ids: [notebookRoot], include_descendants: false });
	assert.deepEqual(direct.items.map(item => item.note_id), [ids[0]]);
	const empty = await service.grepNotes({ pattern: 'needle', note_ids: [], notebook_ids: [] });
	assert.deepEqual(empty.items, []);
	assert.deepEqual(empty, { accountId: 'alice', items: [], page: 1, limit: 20, hasMore: false });
});

test('pagination counts matching source lines and reports a real lookahead row', async () => {
	const ids = ['1', '2', '3'].map(value => value.repeat(32));
	const notes = new Map([
		[ids[0], makeNote(ids[0], notebookRoot, 'hit\nhit')],
		[ids[1], makeNote(ids[1], notebookRoot, 'hit')],
		[ids[2], makeNote(ids[2], notebookRoot, 'hit\nnone\nhit')],
	]);
	const { service } = fixture(notes);

	const first = await service.grepNotes({ pattern: 'hit', limit: 2 });
	assert.deepEqual(first.items.map(item => [item.note_id, item.line_number]), [[ids[0], 1], [ids[0], 2]]);
	assert.equal(first.hasMore, true);
	const second = await service.grepNotes({ pattern: 'hit', page: 2, limit: 2 });
	assert.deepEqual(second.items.map(item => [item.note_id, item.line_number]), [[ids[1], 1], [ids[2], 1]]);
	assert.equal(second.hasMore, true);
	const third = await service.grepNotes({ pattern: 'hit', page: 3, limit: 2 });
	assert.deepEqual(third.items.map(item => [item.note_id, item.line_number]), [[ids[2], 3]]);
	assert.equal(third.hasMore, false);
});

test('revision snapshot changes are re-matched before a line is returned', async () => {
	const id = '4'.repeat(32);
	const notes = new Map([[id, makeNote(id, notebookRoot, 'match')]]);
	const snapshots = new Map([[id, makeNote(id, notebookRoot, 'changed', { revision_id: 'f'.repeat(32) })]]);
	const { service, calls } = fixture(notes, { snapshots });
	const result = await service.grepNotes({ pattern: 'match' });
	assert.deepEqual(result.items, []);
	assert.equal(result.hasMore, false);
	assert.deepEqual(calls.captures, [id]);
});

test('line previews honor the UTF-16 limit without splitting surrogate pairs', async () => {
	const id = '5'.repeat(32);
	const notes = new Map([[id, makeNote(id, notebookRoot, 'A😀B target\ncontext😀')]]);
	const { service } = fixture(notes);
	const result = await service.grepNotes({ pattern: 'target', max_line_chars: 2, context_after: 1 });
	assert.equal(result.items[0].text, 'A');
	assert.equal(result.items[0].line_length, 11);
	assert.equal(result.items[0].truncated, true);
	assert.deepEqual(result.items[0].context_after, [{ line_number: 2, text: 'co', truncated: true, line_length: 9 }]);
});

test('grep validates regular expressions, selections, and matching permissions', async () => {
	const id = '6'.repeat(32);
	const notes = new Map([[id, makeNote(id, notebookRoot, 'text')]]);
	const { service, calls } = fixture(notes);
	await assert.rejects(service.grepNotes({ pattern: '[', mode: 'regex' }), { code: 'invalid_grep_pattern' });
	await assert.rejects(service.grepNotes({ pattern: 'x', note_ids: ['bad'] }), { code: 'invalid_grep_input' });
	await assert.rejects(service.grepNotes({ pattern: 'x', note_ids: ['7'.repeat(32)] }), { code: 'note_unavailable' });
	assert.equal(calls.summaryReads, 0);
	await assert.rejects(service.grepNotes({ pattern: 'x', notebook_ids: ['8'.repeat(32)] }), { code: 'notebook_unavailable' });

	const readOnlyConfig = account('bob');
	readOnlyConfig.permissions = ['write'];
	const denied = createAccountRegistry([readOnlyConfig], { makeBackend: () => ({}) }).forPrincipal('bob', 'bob');
	await assert.rejects(denied.grepNotes({ pattern: 'x' }), { code: 'operation_not_permitted' });
});
