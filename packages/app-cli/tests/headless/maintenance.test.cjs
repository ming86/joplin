const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');

const tagId = 'c'.repeat(32);

test('native tag lookup uses Tag.loadByTitle and returns only safe tag fields', async () => {
	const calls = [];
	let result = {
		id: tagId, title: 'Canonical', encryption_applied: 0, created_time: 123, user_data: 'private',
	};
	const Tag = { async loadByTitle(title) { calls.push(title); return result; } };
	const { createHeadlessMaintenanceActions } = load('packages/app-cli/app/headless/maintenance.ts', {
		'@joplin/lib/models/Tag': Tag,
		'@joplin/lib/models/Folder': {},
	});
	const actions = createHeadlessMaintenanceActions();

	assert.equal(Object.getPrototypeOf(actions), null);
	assert.deepEqual(Object.keys(actions), ['maintenanceUpdateNotebook', 'findTagByTitle']);
	assert.deepEqual(await actions.findTagByTitle({ title: '  CANONICAL  ' }), { tag: { id: tagId, title: 'Canonical' } });
	assert.deepEqual(calls, ['  CANONICAL  ']);

	result = null;
	assert.deepEqual(await actions.findTagByTitle({ title: 'Missing' }), { tag: null });
	assert.deepEqual(calls, ['  CANONICAL  ', 'Missing']);
});

test('native tag lookup reports a matched encrypted tag as unavailable', async () => {
	const Tag = { async loadByTitle() { return { id: tagId, title: 'Private', encryption_applied: 1 }; } };
	const { createHeadlessMaintenanceActions } = load('packages/app-cli/app/headless/maintenance.ts', {
		'@joplin/lib/models/Tag': Tag,
		'@joplin/lib/models/Folder': {},
	});

	await assert.rejects(createHeadlessMaintenanceActions().findTagByTitle({ title: 'Private' }), /Tag unavailable\./);
});

test('native tag lookup rejects invalid action input before loading the model', async () => {
	let calls = 0;
	const Tag = { async loadByTitle() { calls++; return null; } };
	const { createHeadlessMaintenanceActions } = load('packages/app-cli/app/headless/maintenance.ts', {
		'@joplin/lib/models/Tag': Tag,
		'@joplin/lib/models/Folder': {},
	});
	const findTagByTitle = createHeadlessMaintenanceActions().findTagByTitle;

	await assert.rejects(findTagByTitle({ title: 'Tag', unexpected: true }), /Unsupported tag lookup property\./);
	await assert.rejects(findTagByTitle({ title: '   ' }), /Invalid tag title\./);
	assert.equal(calls, 0);
});
