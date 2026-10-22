const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');

function fixture() {
	const types = { TYPE_NOTE: 1, TYPE_FOLDER: 2, TYPE_RESOURCE: 4, TYPE_TAG: 5, TYPE_NOTE_TAG: 6 };
	let persist = async value => value;
	class BaseModel {
		static isNew() { return true; }
		static async save(value) { return persist(value); }
		static async batchDelete() { await persist(); }
	}
	Object.assign(BaseModel, types);
	const mocks = Object.fromEntries([
		'./Setting', '../time', '../markdownUtils', '../locale', '../database',
		'../services/share/ShareService', './utils/itemCanBeEncrypted',
		'../services/synchronizer/syncInfoUtils', '../JoplinError', '@joplin/utils/object',
		'sprintf-js', 'moment',
	].map(name => [name, {}]));
	Object.assign(mocks, {
		'../BaseModel': { default: BaseModel, __esModule: true },
		'./ItemChange': { SOURCE_SYNC: 2 },
		'./ConflictNoteState': { deleteByNoteIds: async () => {} },
		'./utils/readOnly': { needsShareReadOnlyChecks: () => false },
	});
	const BaseItem = load('packages/lib/models/BaseItem.ts', mocks).default;
	class Item extends BaseItem {
		static type = types.TYPE_TAG;
		static modelType() { return this.type; }
	}
	return { Item, BaseItem, types, setPersistence: callback => { persist = callback; } };
}

test('native BaseItem save notifies headless sync only after successful persistence and excludes remote writes', async () => {
	const { Item, BaseItem, types, setPersistence } = fixture();
	const events = [];
	BaseItem.setLocalChangeHandler(() => events.push('notify'));
	let commit;
	setPersistence(async value => { await new Promise(resolve => { commit = resolve; }); events.push('commit'); return value; });
	const saving = Item.save({ id: 'one' });
	assert.deepEqual(events, []);
	commit(); await saving;
	assert.deepEqual(events, ['commit', 'notify']);
	setPersistence(async value => value);
	for (const type of [types.TYPE_NOTE, types.TYPE_FOLDER, types.TYPE_TAG, types.TYPE_NOTE_TAG]) {
		Item.type = type;
		await Item.save({ id: 'remote' }, { changeSource: 2 });
		assert.equal(events.length, 2, 'sync/decryption saves do not echo into followups');
		await Item.save({ id: 'local' });
		events.pop();
	}
	Item.type = types.TYPE_RESOURCE;
	await Item.save({ id: 'resource' });
	assert.equal(events.length, 2, 'attachment action owns notification after blob completion');
	setPersistence(async () => { throw new Error('transaction rolled back'); });
	Item.type = types.TYPE_TAG;
	await assert.rejects(Item.save({ id: 'failed' }));
	assert.equal(events.length, 2);
	BaseItem.setLocalChangeHandler(null);
	setPersistence(async value => value);
	await Item.save({ id: 'after-stop' });
	assert.equal(events.length, 2);
});

test('native deletion notifies after completion and excludes remotely applied deletes', async () => {
	const { Item, BaseItem, types, setPersistence } = fixture();
	const events = [];
	BaseItem.setLocalChangeHandler(() => events.push('notify'));
	setPersistence(async () => { events.push('delete'); });
	await Item.batchDelete(['one'], { trackDeleted: false });
	assert.deepEqual(events, ['delete', 'notify']);
	await Item.batchDelete(['remote'], { trackDeleted: false, changeSource: 2 });
	assert.deepEqual(events, ['delete', 'notify', 'delete']);
	Item.type = types.TYPE_RESOURCE;
	await Item.batchDelete(['attachment'], { trackDeleted: false });
	assert.deepEqual(events, ['delete', 'notify', 'delete', 'delete', 'notify']);
	BaseItem.setLocalChangeHandler(null);
});
