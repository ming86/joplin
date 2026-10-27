const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
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
		'@joplin/lib/models/Note': {},
		'@joplin/lib/models/Folder': {},
	});
	const actions = createHeadlessMaintenanceActions();

	assert.equal(Object.getPrototypeOf(actions), null);
	assert.deepEqual(Object.keys(actions), ['maintenanceUpdateNotebook', 'findTagByTitle', 'notebookNoteCounts']);
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
		'@joplin/lib/models/Note': {},
		'@joplin/lib/models/Folder': {},
	});

	await assert.rejects(createHeadlessMaintenanceActions().findTagByTitle({ title: 'Private' }), /Tag unavailable\./);
});

test('native tag lookup rejects invalid action input before loading the model', async () => {
	let calls = 0;
	const Tag = { async loadByTitle() { calls++; return null; } };
	const { createHeadlessMaintenanceActions } = load('packages/app-cli/app/headless/maintenance.ts', {
		'@joplin/lib/models/Tag': Tag,
		'@joplin/lib/models/Note': {},
		'@joplin/lib/models/Folder': {},
	});
	const findTagByTitle = createHeadlessMaintenanceActions().findTagByTitle;

	await assert.rejects(findTagByTitle({ title: 'Tag', unexpected: true }), /Unsupported tag lookup property\./);
	await assert.rejects(findTagByTitle({ title: '   ' }), /Invalid tag title\./);
	assert.equal(calls, 0);
});

test('native notebook counts group eligible notes by their direct parent', async t => {
	const requireFromLib = createRequire(path.resolve(__dirname, '../../../lib/package.json'));
	const sqlite = requireFromLib('sqlite3').verbose();
	let database;
	await new Promise((resolve, reject) => {
		database = new sqlite.Database(':memory:', error => error ? reject(error) : resolve());
	});
	t.after(() => new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve())));

	const run = (sql, params = []) => new Promise((resolve, reject) => {
		database.run(sql, params, error => error ? reject(error) : resolve());
	});
	const selectAll = (sql, params = []) => new Promise((resolve, reject) => {
		database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
	});
	await run(`CREATE TABLE notes (
		id TEXT,
		parent_id TEXT,
		is_conflict INTEGER,
		deleted_time INTEGER,
		encryption_applied INTEGER,
		is_locked INTEGER
	)`);

	const insertNote = async (id, parentId, { conflict = 0, deleted = 0, encrypted = 0, locked = 0 } = {}) => {
		await run('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?)', [id, parentId, conflict, deleted, encrypted, locked]);
	};
	await insertNote('direct-1', 'notebook-a');
	await insertNote('direct-2', 'notebook-a', { deleted: null, locked: null });
	await insertNote('child-1', 'child-notebook');
	await insertNote('empty-parent', '');
	await insertNote('orphan-parent', 'missing-notebook');
	await insertNote('conflict', 'notebook-a', { conflict: 1 });
	await insertNote('deleted', 'notebook-a', { deleted: 123 });
	await insertNote('encrypted', 'notebook-a', { encrypted: 1 });
	await insertNote('locked', 'notebook-a', { locked: 1 });
	await insertNote('incomplete-encryption', 'notebook-a', { encrypted: null });

	const queryCalls = [];
	const Note = { db: () => ({
		async selectAll(sql, params) {
			queryCalls.push(sql);
			return selectAll(sql, params);
		},
	}) };
	const { createHeadlessMaintenanceActions } = load('packages/app-cli/app/headless/maintenance.ts', {
		'@joplin/lib/models/Note': Note,
		'@joplin/lib/models/Tag': {},
		'@joplin/lib/models/Folder': {},
	});
	const actions = createHeadlessMaintenanceActions();

	assert.deepEqual(Object.keys(actions), ['maintenanceUpdateNotebook', 'findTagByTitle', 'notebookNoteCounts']);
	assert.deepEqual(await actions.notebookNoteCounts(), {
		counts: {
			'notebook-a': 2,
			'child-notebook': 1,
			'': 1,
			'missing-notebook': 1,
		},
	});
	assert.equal(queryCalls.length, 1);
});
