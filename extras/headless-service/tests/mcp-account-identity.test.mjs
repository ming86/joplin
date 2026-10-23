import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountResultPresenter } from '../src/mcp/account-identity.mjs';
import { getToolOutputSchema } from '../src/mcp/output-schemas.mjs';

const accountEmail = 'profile@example.com';
const accountId = 'local-binding';

// Public identity locations follow tool contracts; arbitrary note/history values are opaque.
test('presents account email at every attributed root without modifying the service result', async () => {
	let calls = 0;
	const present = createAccountResultPresenter({ status: async () => { calls++; return { accountEmail }; } });
	for (const name of ['list_notes', 'search_notes', 'read_note', 'get_note', 'list_note_revisions', 'read_note_revision',
		'compare_note_revisions', 'list_conflicts', 'read_conflict', 'update_notebook', 'delete_notebook',
		'create_tag', 'rename_tag', 'read_attachment', 'create_attachment', 'update_attachment']) {
		const opaque = { accountId: 'user-value', nested: { accountId: 'also-user-data' } };
		const source = { accountId, id: 'item', metadata: opaque, metadata_changes: [{ from: { value: opaque } }] };
		const result = await present(name, source);
		assert.equal(result.accountEmail, accountEmail, name);
		assert.equal(Object.hasOwn(result, 'accountId'), false, name);
		assert.equal(source.accountId, accountId);
		assert.equal(result.metadata, opaque);
		assert.equal(result.metadata_changes[0].from.value, opaque);
	}
	assert.equal(calls, 1);
});

test('projects nested attributed list rows with one lookup, preserving other dictionaries', async () => {
	let calls = 0;
	const present = createAccountResultPresenter({ status: async () => { calls++; return { accountEmail }; } });
	for (const [name, key] of [['list_notes', 'items'], ['list_note_revisions', 'items'], ['list_note_attachments', 'attachments']]) {
		const source = { ...(name === 'list_note_revisions' ? { accountId } : {}), [key]: [
			{ id: 'first', accountId, metadata: { accountId: 'content' } }, { id: 'second', accountId },
		] };
		const result = await present(name, source);
		assert.deepEqual(result[key].map(row => row.accountEmail), [accountEmail, accountEmail]);
		assert.ok(result[key].every(row => !Object.hasOwn(row, 'accountId')));
		assert.equal(result[key][0].metadata.accountId, 'content');
		assert.equal(source[key][0].accountId, accountId);
		assert.equal(Object.hasOwn(result, 'accountEmail'), name === 'list_note_revisions');
	}
	assert.equal(calls, 1);
});

test('leaves compact acknowledgements, unattributed tools and errors untouched', async () => {
	const present = createAccountResultPresenter({ status: () => { throw new Error('unexpected lookup'); } });
	for (const name of ['update_note', 'create_note', 'delete_note', 'create_notebook', 'manage_tags', 'list_notebooks', 'list_tags', 'semantic_search_notes']) {
		const source = { id: 'item', metadata: { accountId: 'content' } };
		assert.equal(await present(name, source), source);
	}
	const error = { error: { code: 'operation_failed', accountId: 'error-content' } };
	assert.equal(await present('read_note', error), error);
	const unattributed = { id: 'item' };
	assert.equal(await present('read_note', unattributed), unattributed);
});

test('uses status result directly, retaining diagnostic accountId and seeding shared cache', async () => {
	let calls = 0;
	const service = { status: async () => { calls++; return { accountEmail: 'wrong@example.com' }; } };
	const present = createAccountResultPresenter(service);
	assert.deepEqual(await present('get_status', { accountId, accountEmail }), { accountId, accountEmail });
	const anotherSession = createAccountResultPresenter(service);
	assert.deepEqual(await anotherSession('read_note', { accountId }), { accountEmail });
	assert.equal(calls, 0);
	assert.deepEqual(await present('get_status', { accountId }), { accountId, accountEmail: null });
	assert.equal(calls, 0);
});

test('coalesces concurrent lookup across presenters bound to the same service', async () => {
	let calls = 0;
	let finish;
	const service = { status: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
	const first = createAccountResultPresenter(service)('read_note', { accountId });
	const second = createAccountResultPresenter(service)('read_attachment', { accountId });
	await Promise.resolve();
	assert.equal(calls, 1);
	finish({ accountEmail });
	assert.deepEqual(await Promise.all([first, second]), [{ accountEmail }, { accountEmail }]);
	assert.deepEqual(await createAccountResultPresenter(service)('create_attachment', { accountId }), { accountEmail });
	assert.equal(calls, 1);
});

test('coalesced auxiliary lookup failure preserves committed write results', async () => {
	let calls = 0;
	let fail;
	const service = { status: () => { calls++; return new Promise((_resolve, reject) => { fail = reject; }); } };
	const present = createAccountResultPresenter(service);
	const first = present('create_attachment', { accountId, id: 'created' });
	const second = present('update_attachment', { accountId, id: 'updated' });
	await Promise.resolve();
	assert.equal(calls, 1);
	fail(new Error('offline'));
	assert.deepEqual(await Promise.all([first, second]), [
		{ id: 'created', accountEmail: null },
		{ id: 'updated', accountEmail: null },
	]);
});

test('returns nullable identity for missing status, missing email, and lookup failure; retries unavailable identity', async () => {
	for (const service of [{}, { status: async () => ({}) }, { status: () => { throw new Error('offline'); } },
		{ status: async () => { throw new Error('offline'); } }, { status: async () => ({ accountEmail: '  ' }) }]) {
		assert.deepEqual(await createAccountResultPresenter(service)('create_attachment', { accountId, id: 'created' }), { accountEmail: null, id: 'created' });
	}
	let calls = 0;
	const present = createAccountResultPresenter({ status: async () => (++calls === 1 ? {} : { accountEmail }) });
	assert.deepEqual(await present('read_note', { accountId }), { accountEmail: null });
	assert.deepEqual(await present('read_note', { accountId }), { accountEmail });
	assert.deepEqual(await present('read_note', { accountId }), { accountEmail });
	assert.equal(calls, 2);
});

test('output schemas describe nullable emails only where results carry account identity', () => {
	const success = name => getToolOutputSchema(name).anyOf[0];
	for (const name of ['read_note', 'get_note', 'search_notes', 'list_note_revisions', 'read_note_revision',
		'compare_note_revisions', 'list_conflicts', 'read_conflict', 'update_notebook', 'delete_notebook',
		'create_tag', 'rename_tag', 'read_attachment', 'create_attachment', 'update_attachment']) {
		const schema = success(name);
		assert.deepEqual(schema.properties.accountEmail.type, ['string', 'null'], name);
		assert.ok(schema.required.includes('accountEmail'), name);
		assert.equal(Object.hasOwn(schema.properties, 'accountId'), false, name);
	}
	for (const [name, key] of [['list_notes', 'items'], ['list_note_revisions', 'items'], ['list_note_attachments', 'attachments']]) {
		const schema = success(name).properties[key].items;
		assert.ok(schema.required.includes('accountEmail'), name);
		assert.equal(Object.hasOwn(schema.properties, 'accountId'), false, name);
	}
	for (const name of ['update_note', 'create_note', 'delete_note', 'create_notebook', 'manage_tags', 'list_notebooks', 'list_tags']) {
		assert.equal(Object.hasOwn(success(name).properties, 'accountEmail'), false, name);
	}
	assert.match(success('get_status').properties.accountId.description, /Local account binding ID/);
	assert.deepEqual(success('get_status').properties.accountEmail.type, ['string', 'null']);
});
