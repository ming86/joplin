import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../src/errors.mjs';
import { createTrashService } from '../src/trash.mjs';
import { registerTrashTools } from '../src/mcp/trash-tools.mjs';
import { trashOutputSchemas } from '../src/mcp/trash-output-schemas.mjs';

const noteId = 'a'.repeat(32);
const notebookId = 'b'.repeat(32);
const parentId = 'c'.repeat(32);
const listing = { items: [], hasMore: false };

test('Trash service checks account permissions and returns account-bound compact results', async () => {
	const calls = [];
	const permissions = [];
	const backend = {
		async listTrash(input, signal) { calls.push(['list', input, signal]); return listing; },
		async restoreNote(input, signal) { calls.push(['note', input, signal]); return { id: noteId, parent_id: parentId, restored: true }; },
		async restoreNotebook(input, signal) { calls.push(['notebook', input, signal]); return { id: notebookId, parent_id: '', restored: true }; },
	};
	const service = createTrashService({
		backend: () => backend,
		permit(permission) { permissions.push(permission); },
		accountId: 'alice',
	});
	const signal = new AbortController().signal;

	assert.deepEqual(await service.listTrash({}, signal), { accountId: 'alice', ...listing });
	assert.deepEqual(await service.listTrash({ page: 3, limit: 7 }, signal), { accountId: 'alice', ...listing });
	assert.deepEqual(await service.restoreNote({ id: noteId }, signal), { accountId: 'alice', id: noteId, parent_id: parentId, restored: true });
	assert.deepEqual(await service.restoreNotebook({ id: notebookId }, signal), { accountId: 'alice', id: notebookId, parent_id: '', restored: true });
	assert.deepEqual(permissions, ['read', 'read', 'write', 'write']);
	assert.deepEqual(calls, [
		['list', { page: 1, limit: 20 }, signal],
		['list', { page: 3, limit: 7 }, signal],
		['note', { id: noteId }, signal],
		['notebook', { id: notebookId }, signal],
	]);

	await assert.rejects(service.listTrash({ selector: 'all' }), { code: 'invalid_trash_input' });
	await assert.rejects(service.restoreNote({ id: 'bad' }), { code: 'invalid_trash_input' });
	const denied = createTrashService({
		backend: () => backend,
		permit() { throw new ServiceError('operation_not_permitted'); },
		accountId: 'alice',
	});
	await assert.rejects(denied.listTrash(), { code: 'operation_not_permitted' });
	await assert.rejects(denied.restoreNote({ id: noteId }), { code: 'operation_not_permitted' });
});

test('Trash MCP tools use compact inputs, document restore behavior, and honor write availability', async () => {
	const calls = [];
	const service = {
		async listTrash(input, signal) { calls.push(['list', input, signal]); return { accountId: 'alice', items: [], hasMore: false }; },
		async restoreNote(input, signal) { calls.push(['note', input, signal]); return { accountId: 'alice', id: noteId, parent_id: '', restored: true }; },
		async restoreNotebook(input, signal) { calls.push(['notebook', input, signal]); return { accountId: 'alice', id: notebookId, parent_id: '', restored: true }; },
	};
	const tools = new Map();
	registerTrashTools((name, description, inputSchema, run, annotations) => tools.set(name, { description, inputSchema, run, annotations }), service);
	assert.deepEqual([...tools.keys()], ['list_trash', 'restore_note', 'restore_notebook']);
	assert.equal(tools.get('list_trash').annotations.readOnlyHint, true);
	assert.equal(tools.get('restore_note').annotations.readOnlyHint, false);
	assert.equal(tools.get('restore_note').annotations.destructiveHint, false);
	assert.match(tools.get('restore_note').description, /notebook root/i);
	assert.match(tools.get('restore_notebook').description, /descendant notebooks and notes/i);

	const signal = new AbortController().signal;
	assert.deepEqual(await tools.get('list_trash').run({}, signal), { accountId: 'alice', items: [], hasMore: false });
	await tools.get('restore_note').run({ id: noteId }, signal);
	await tools.get('restore_notebook').run({ id: notebookId }, signal);
	assert.deepEqual(calls, [
		['list', { page: undefined, limit: 20 }, signal],
		['note', { id: noteId }, signal],
		['notebook', { id: notebookId }, signal],
	]);

	const readOnlyTools = new Map();
	registerTrashTools((name, ...args) => readOnlyTools.set(name, args), service, { allowWrites: false });
	assert.deepEqual([...readOnlyTools.keys()], ['list_trash']);

	for (const name of ['list_trash', 'restore_note', 'restore_notebook']) {
		assert.ok(trashOutputSchemas[name]);
		assert.ok(trashOutputSchemas[name].required.includes('accountEmail'));
		assert.ok(!Object.hasOwn(trashOutputSchemas[name].properties, 'accountId'));
	}
});
