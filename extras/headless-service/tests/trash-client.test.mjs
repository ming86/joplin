import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrashClient } from '../src/trash-client.mjs';

const noteId = 'a'.repeat(32);
const notebookId = 'b'.repeat(32);
const parentId = 'c'.repeat(32);
const noteItem = {
	id: noteId,
	type: 'note',
	title: 'Conflict copy',
	parent_id: parentId,
	deleted_time: 30,
	updated_time: 20,
	is_conflict: 1,
	local_path: '/private/path',
};
const notebookItem = {
	id: notebookId,
	type: 'notebook',
	title: 'Archive',
	parent_id: '',
	deleted_time: 10,
	updated_time: 5,
};

test('Trash client sends fixed actions, marks only restores as writes, and allowlists results', async () => {
	const calls = [];
	const responses = [
		{ items: [noteItem, notebookItem], hasMore: true },
		{ id: noteId, parent_id: parentId, restored: true, private_value: 'remove' },
		{ id: notebookId, parent_id: '', restored: true, private_value: 'remove' },
	];
	const client = createTrashClient(async (...args) => { calls.push(args); return responses.shift(); });
	const signal = new AbortController().signal;

	assert.deepEqual(await client.listTrash({ page: 2, limit: 3 }, signal), {
		items: [
			{ id: noteId, type: 'note', title: 'Conflict copy', parent_id: parentId, deleted_time: 30, updated_time: 20, is_conflict: 1 },
			{ id: notebookId, type: 'notebook', title: 'Archive', parent_id: '', deleted_time: 10, updated_time: 5 },
		],
		hasMore: true,
	});
	assert.deepEqual(await client.restoreNote({ id: noteId }, signal), { id: noteId, parent_id: parentId, restored: true });
	assert.deepEqual(await client.restoreNotebook({ id: notebookId }, signal), { id: notebookId, parent_id: '', restored: true });
	assert.deepEqual(calls.map(call => call[3]), [
		{ action: 'listTrash', page: 2, limit: 3 },
		{ action: 'restoreNote', id: noteId },
		{ action: 'restoreNotebook', id: notebookId },
	]);
	assert.ok(calls.every(call => call[0] === 'services/headless' && call[1] && call[2] === 'POST' && call[4] === signal));
	assert.deepEqual(calls.map(call => call[5]), [
		{ writeOperation: false }, { writeOperation: true }, { writeOperation: true },
	]);
});

test('Trash client validates list inputs and translates only documented unapplied native failures', async () => {
	const unused = createTrashClient(async () => ({ items: [], hasMore: false }));
	await assert.rejects(unused.listTrash({ extra: true }), { code: 'invalid_trash_input' });
	await assert.rejects(unused.listTrash({ page: 0 }), { code: 'invalid_trash_input' });
	await assert.rejects(unused.listTrash({ limit: 101 }), { code: 'invalid_trash_input' });
	await assert.rejects(unused.restoreNote({ id: 'invalid' }), { code: 'invalid_trash_input' });
	await assert.rejects(unused.restoreNotebook({ id: notebookId, extra: true }), { code: 'invalid_trash_input' });

	const knownFailure = createTrashClient(async () => ({ error: {
		code: 'trash_item_not_deleted', message: 'private native detail', applied: false,
	} }));
	await assert.rejects(knownFailure.restoreNote({ id: noteId }), error => {
		assert.equal(error.code, 'trash_item_not_deleted');
		assert.equal(error.outcomeUnknown, false);
		assert.equal(error.message, 'The requested item is no longer in the Trash.');
		assert.ok(!error.message.includes('private native detail'));
		return true;
	});

	const unknownFailure = createTrashClient(async () => ({ error: {
		code: 'unexpected_native_error', message: 'private native detail', applied: false,
	} }));
	await assert.rejects(unknownFailure.restoreNote({ id: noteId }), error => {
		assert.equal(error.code, 'write_outcome_unknown');
		assert.equal(error.outcomeUnknown, true);
		assert.ok(!error.message.includes('private native detail'));
		return true;
	});
});

test('Trash client rejects malformed reads and treats unusable restore replies as uncertain writes', async () => {
	const malformedPage = createTrashClient(async () => ({
		items: [{ ...noteItem, is_conflict: true }], hasMore: false,
	}));
	await assert.rejects(malformedPage.listTrash(), { code: 'invalid_backend_response' });

	const malformedRestore = createTrashClient(async () => ({ id: noteId, parent_id: parentId, restored: false }));
	await assert.rejects(malformedRestore.restoreNote({ id: noteId }), error => {
		assert.equal(error.code, 'write_outcome_unknown');
		assert.equal(error.outcomeUnknown, true);
		return true;
	});

	const unknownErrorEnvelope = createTrashClient(async () => ({ error: { code: 'unexpected', applied: true } }));
	await assert.rejects(unknownErrorEnvelope.restoreNotebook({ id: notebookId }), { code: 'write_outcome_unknown' });
});
