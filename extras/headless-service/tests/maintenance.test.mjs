import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../src/errors.mjs';
import { createMaintenanceService } from '../src/maintenance.mjs';
import { createMaintenanceClient } from '../src/maintenance-client.mjs';
import { registerMaintenanceTools } from '../src/mcp/maintenance-tools.mjs';

const notebookId = 'a'.repeat(32);
const parentId = 'b'.repeat(32);
const tagId = 'c'.repeat(32);

test('maintenance client uses fixed Joplin routes and native notebook update action', async () => {
	const calls = [];
	const request = async (...args) => {
		calls.push(args);
		const [route, , method, body] = args;
		if (route === 'services/headless' && body.action === 'maintenanceUpdateNotebook') return { id: notebookId, title: 'Updated', parent_id: parentId };
		if (route === 'services/headless' && body.action === 'findTagByTitle') return { tag: { id: tagId, title: 'Canonical' } };
		if (route === `tags/${tagId}` && method === 'GET') return { id: tagId, title: 'Old', encryption_applied: 0 };
		if (route === `tags/${tagId}` && method === 'PUT') return { id: tagId, title: body.title, encryption_applied: 0 };
		return null;
	};
	const client = createMaintenanceClient(request);

	assert.deepEqual(await client.updateNotebook(notebookId, { title: 'Updated', parent_id: parentId }), {
		id: notebookId, title: 'Updated', parent_id: parentId,
	});
	assert.deepEqual(await client.findTagByTitle('  canonical  '), { id: tagId, title: 'Canonical' });
	await client.deleteNotebook(notebookId);
	assert.deepEqual(await client.getTag(tagId), { id: tagId, title: 'Old' });
	assert.deepEqual(await client.updateTag(tagId, { title: 'New' }), { id: tagId, title: 'New' });
	assert.deepEqual(calls.map(([route, params, method, body, signal, options]) => ({
		route, params, method, body,
		...(signal === undefined ? {} : { signal }),
		...(options === undefined ? {} : { options }),
	})), [
		{ route: 'services/headless', params: {}, method: 'POST', body: { action: 'maintenanceUpdateNotebook', id: notebookId, title: 'Updated', parent_id: parentId } },
		{ route: 'services/headless', params: {}, method: 'POST', body: { action: 'findTagByTitle', title: '  canonical  ' }, options: { writeOperation: false } },
		{ route: `folders/${notebookId}`, params: {}, method: 'DELETE', body: undefined },
		{ route: `tags/${tagId}`, params: { fields: 'id,title,encryption_applied' }, method: 'GET', body: undefined },
		{ route: `tags/${tagId}`, params: {}, method: 'PUT', body: { title: 'New' } },
	]);
});

test('maintenance client accepts a missing native tag and rejects malformed lookup results', async () => {
	const missing = createMaintenanceClient(async () => ({ tag: null }));
	assert.equal(await missing.findTagByTitle('Missing'), null);

	const malformed = createMaintenanceClient(async () => ({ tag: { id: 'wrong', title: 'Wrong' } }));
	await assert.rejects(malformed.findTagByTitle('Wrong'), { code: 'invalid_backend_response' });
	await assert.rejects(createMaintenanceClient(async () => null).findTagByTitle('Missing'), { code: 'invalid_backend_response' });

	const unavailable = createMaintenanceClient(async () => { throw new ServiceError('tag_unavailable'); });
	await assert.rejects(unavailable.findTagByTitle('Private'), { code: 'tag_unavailable' });
});

test('maintenance client rejects encrypted tags and marks invalid write responses uncertain', async () => {
	const encrypted = createMaintenanceClient(async () => ({ id: tagId, title: 'Private', encryption_applied: 1 }));
	await assert.rejects(encrypted.getTag(tagId), { code: 'tag_unavailable' });

	const malformed = createMaintenanceClient(async () => ({ id: 'wrong', title: 'Wrong', parent_id: '' }));
	await assert.rejects(malformed.updateNotebook(notebookId, { title: 'Name' }), {
		code: 'write_outcome_unknown', outcomeUnknown: true,
	});
});

function maintenanceBackend() {
	const calls = [];
	return {
		calls,
		async getNotebook(id) { calls.push(['getNotebook', id]); return { id, title: 'Notebook', parent_id: '' }; },
		async updateNotebook(id, patch) { calls.push(['updateNotebook', id, patch]); return { id, title: patch.title ?? 'Notebook', parent_id: patch.parent_id ?? '' }; },
		async deleteNotebook(id) { calls.push(['deleteNotebook', id]); },
		async createTag(title) { calls.push(['createTag', title]); return { id: tagId, title }; },
		async findTagByTitle(title) { calls.push(['findTagByTitle', title]); return null; },
		async getTag(id) { calls.push(['getTag', id]); return { id, title: 'Old' }; },
		async updateTag(id, patch) { calls.push(['updateTag', id, patch]); return { id, title: patch.title }; },
	};
}

test('account maintenance verifies notebook eligibility, preserves tag relationships, and reports trash semantics', async () => {
	const backend = maintenanceBackend();
	const permissions = [];
	const service = createMaintenanceService({ backend: () => backend, permit: permission => permissions.push(permission), accountId: 'alice' });

	assert.deepEqual(await service.updateNotebook(notebookId, { parent_id: parentId, title: 'Renamed' }), {
		id: notebookId, title: 'Renamed', parent_id: parentId, accountId: 'alice',
	});
	assert.deepEqual(await service.updateNotebook(notebookId, { parent_id: '' }), {
		id: notebookId, title: 'Notebook', parent_id: '', accountId: 'alice',
	});
	assert.deepEqual(await service.deleteNotebook(notebookId), { id: notebookId, trashed: true, accountId: 'alice' });
	assert.deepEqual(await service.createTag('  New tag  '), { id: tagId, title: 'New tag', accountId: 'alice' });
	assert.deepEqual(await service.renameTag(tagId, 'Renamed tag'), { id: tagId, title: 'Renamed tag', accountId: 'alice' });
	assert.deepEqual(backend.calls, [
		['getNotebook', notebookId], ['getNotebook', parentId], ['updateNotebook', notebookId, { parent_id: parentId, title: 'Renamed' }],
		['getNotebook', notebookId], ['updateNotebook', notebookId, { parent_id: '' }],
		['getNotebook', notebookId], ['deleteNotebook', notebookId],
		['createTag', 'New tag'], ['getTag', tagId], ['updateTag', tagId, { title: 'Renamed tag' }],
	]);
	assert.deepEqual(permissions, Array(5).fill('write'));
});

test('maintenance writes stop at account permission and notebook eligibility boundaries', async () => {
	let backendCalls = 0;
	const backend = maintenanceBackend();
	for (const name of Object.keys(backend)) {
		if (name === 'calls') continue;
		const original = backend[name];
		backend[name] = async (...args) => { backendCalls++; return original(...args); };
	}
	const forbidden = createMaintenanceService({
		backend: () => backend, permit: () => { throw new ServiceError('operation_not_permitted'); }, accountId: 'alice',
	});
	await assert.rejects(forbidden.deleteNotebook(notebookId), { code: 'operation_not_permitted' });
	assert.equal(backendCalls, 0);

	const unavailableBackend = maintenanceBackend();
	unavailableBackend.getNotebook = async () => { throw new ServiceError('clip_notebook_unavailable'); };
	const service = createMaintenanceService({ backend: () => unavailableBackend, permit: () => {}, accountId: 'alice' });
	await assert.rejects(service.updateNotebook(notebookId, { title: 'No edit' }), { code: 'clip_notebook_unavailable' });
	assert.deepEqual(unavailableBackend.calls, []);
});

test('maintenance tool registration exposes only the selected notebook and tag actions', async () => {
	const calls = [];
	const tools = new Map();
	const service = {
		async updateNotebook(...args) { calls.push(['update_notebook', ...args]); return { id: notebookId }; },
		async deleteNotebook(...args) { calls.push(['delete_notebook', ...args]); return { id: notebookId, trashed: true }; },
		async createTag(...args) { calls.push(['create_tag', ...args]); return { id: tagId }; },
		async renameTag(...args) { calls.push(['rename_tag', ...args]); return { id: tagId }; },
	};
	registerMaintenanceTools((name, description, inputSchema, run, annotations) => {
		tools.set(name, { description, inputSchema, run, annotations });
	}, service);

	assert.deepEqual([...tools.keys()], ['update_notebook', 'delete_notebook', 'create_tag', 'rename_tag']);
	assert.equal(tools.get('update_notebook').inputSchema.additionalProperties, false);
	assert.deepEqual(tools.get('update_notebook').inputSchema.anyOf, [{ required: ['title'] }, { required: ['parent_id'] }]);
	assert.equal(tools.get('update_notebook').inputSchema.properties.parent_id.pattern, '^(?:[a-f0-9]{32})?$');
	assert.match(tools.get('delete_notebook').description, /can be restored from the trash\./);
	assert.equal(tools.has('delete_tag'), false);
	assert.equal(tools.has('permanently_delete_notebook'), false);

	await tools.get('update_notebook').run({ id: notebookId, parent_id: '' }, 'signal');
	await tools.get('delete_notebook').run({ id: notebookId }, 'signal');
	await tools.get('create_tag').run({ title: 'New' }, 'signal');
	await tools.get('rename_tag').run({ id: tagId, title: 'Renamed' }, 'signal');
	assert.deepEqual(calls, [
		['update_notebook', notebookId, { parent_id: '' }, 'signal'],
		['delete_notebook', notebookId, 'signal'],
		['create_tag', 'New', 'signal'],
		['rename_tag', tagId, 'Renamed', 'signal'],
	]);
});
