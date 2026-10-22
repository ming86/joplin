const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');

function fixture() {
	const types = { TYPE_NOTE: 1, TYPE_FOLDER: 2, TYPE_RESOURCE: 4, TYPE_TAG: 5, TYPE_NOTE_TAG: 6, TYPE_MASTER_KEY: 9, TYPE_REVISION: 13 };
	let persist = async value => value;
	let dbExec = async () => {};
	let outgoingItems = [];
	const database = {
		exec: (...args) => dbExec(...args),
		escapeField: field => `\`${field}\``,
		escapeValues: values => values.map(value => `'${value}'`),
	};
	class BaseModel {
		static isNew() { return true; }
		static async save(value) { return persist(value); }
		static async batchDelete() { await persist(); }
		static db() { return database; }
		static escapeIdsForSql(values) { return database.escapeValues(values).join(', '); }
	}
	Object.assign(BaseModel, types);
	const mocks = Object.fromEntries([
		'./Setting', '../time', '../markdownUtils', '../locale', '../database',
		'../services/share/ShareService', './utils/itemCanBeEncrypted',
		'../services/synchronizer/syncInfoUtils', '../JoplinError', '@joplin/utils/object', 'moment',
	].map(name => [name, {}]));
	Object.assign(mocks, {
		'sprintf-js': require('sprintf-js'),
		'../BaseModel': { default: BaseModel, __esModule: true },
		'./ItemChange': { SOURCE_SYNC: 2 },
		'./ConflictNoteState': { deleteByNoteIds: async () => {} },
		'./utils/readOnly': { needsShareReadOnlyChecks: () => false },
	});
	const BaseItem = load('packages/lib/models/BaseItem.ts', mocks).default;
	class Item extends BaseItem {
		static type = types.TYPE_TAG;
		static modelType() { return this.type; }
		static tableName() { return 'items'; }
		static async modelSelectAll() { return outgoingItems; }
	}
	return {
		Item,
		BaseItem,
		types,
		setPersistence: callback => { persist = callback; },
		setDatabasePersistence: callback => { dbExec = callback; },
		setOutgoingItems: items => { outgoingItems = items; },
	};
}

test('native BaseItem save notifies headless sync only after successful persistence and excludes remote writes', async () => {
	const { Item, BaseItem, types, setPersistence } = fixture();
	const events = [];
	BaseItem.setLocalChangeHandler(() => events.push('notify'));
	let generation = BaseItem.localChangeGeneration();
	let commit;
	setPersistence(async value => { await new Promise(resolve => { commit = resolve; }); events.push('commit'); return value; });
	const saving = Item.save({ id: 'one' });
	assert.deepEqual(events, []);
	commit(); await saving;
	assert.deepEqual(events, ['commit', 'notify']);
	assert.equal(BaseItem.localChangeGeneration(), generation + 1);
	generation++;
	setPersistence(async value => value);
	for (const type of [types.TYPE_NOTE, types.TYPE_FOLDER, types.TYPE_TAG, types.TYPE_NOTE_TAG, types.TYPE_MASTER_KEY, types.TYPE_REVISION]) {
		Item.type = type;
		await Item.save({ id: 'remote' }, { changeSource: 2 });
		assert.equal(events.length, 2, 'sync/decryption saves do not echo into followups');
		assert.equal(BaseItem.localChangeGeneration(), generation, 'sync/decryption saves do not advance local generation');
		await Item.save({ id: 'local' });
		assert.equal(BaseItem.localChangeGeneration(), generation + 1);
		generation++;
		events.pop();
	}
	Item.type = types.TYPE_RESOURCE;
	await Item.save({ id: 'resource' });
	assert.equal(events.length, 2, 'attachment action owns notification after blob completion');
	assert.equal(BaseItem.localChangeGeneration(), generation + 1, 'resource metadata still counts as outgoing work during prep');
	generation++;
	setPersistence(async () => { throw new Error('transaction rolled back'); });
	Item.type = types.TYPE_TAG;
	await assert.rejects(Item.save({ id: 'failed' }));
	assert.equal(events.length, 2);
	assert.equal(BaseItem.localChangeGeneration(), generation, 'failed saves do not advance local generation');
	BaseItem.setLocalChangeHandler(null);
	setPersistence(async value => value);
	await Item.save({ id: 'after-stop' });
	assert.equal(events.length, 2);
	assert.equal(BaseItem.localChangeGeneration(), generation + 1, 'local writes count even when no scheduler is installed');
});

test('native deletion notifies after completion and excludes remotely applied deletes', async () => {
	const { Item, BaseItem, types, setPersistence } = fixture();
	const events = [];
	BaseItem.setLocalChangeHandler(() => events.push('notify'));
	let generation = BaseItem.localChangeGeneration();
	setPersistence(async () => { events.push('delete'); });
	await Item.batchDelete(['one'], { trackDeleted: false });
	assert.deepEqual(events, ['delete', 'notify']);
	assert.equal(BaseItem.localChangeGeneration(), generation + 1);
	generation++;
	await Item.batchDelete(['remote'], { trackDeleted: false, changeSource: 2 });
	assert.deepEqual(events, ['delete', 'notify', 'delete']);
	assert.equal(BaseItem.localChangeGeneration(), generation, 'sync/decryption deletes do not advance local generation');
	for (const type of [types.TYPE_MASTER_KEY, types.TYPE_REVISION]) {
		Item.type = type;
		await Item.batchDelete(['local-special'], { trackDeleted: false });
		assert.equal(events.at(-1), 'notify');
		assert.equal(BaseItem.localChangeGeneration(), generation + 1);
		generation++;
		await Item.batchDelete(['remote-special'], { trackDeleted: false, changeSource: 2 });
		assert.equal(events.at(-1), 'delete');
		assert.equal(BaseItem.localChangeGeneration(), generation);
	}
	Item.type = types.TYPE_RESOURCE;
	await Item.batchDelete(['attachment'], { trackDeleted: false });
	assert.deepEqual(events.slice(-2), ['delete', 'notify']);
	BaseItem.setLocalChangeHandler(null);
});

test('force-sync writes advance local generation and notify only after persistence', async () => {
	const { Item, BaseItem, types, setDatabasePersistence, setOutgoingItems } = fixture();
	const events = [];
	BaseItem.setLocalChangeHandler(() => events.push('notify'));
	setDatabasePersistence(async () => { events.push('persist'); });
	let generation = BaseItem.localChangeGeneration();

	await BaseItem.forceSync('one');
	assert.deepEqual(events, ['persist', 'notify']);
	assert.equal(BaseItem.localChangeGeneration(), generation + 1);
	generation++;

	events.length = 0;
	await BaseItem.forceSyncAll();
	assert.deepEqual(events, ['persist', 'notify']);
	assert.equal(BaseItem.localChangeGeneration(), generation + 1);
	generation++;

	BaseItem.syncItemDefinitions_ = [{ type: types.TYPE_TAG, className: 'Tag', classRef: Item }];
	setOutgoingItems([]);
	events.length = 0;
	await BaseItem.markAllNonEncryptedForSync();
	assert.deepEqual(events, [], 'no items means no write, notification, or generation change');
	assert.equal(BaseItem.localChangeGeneration(), generation);

	setOutgoingItems([{ id: 'two' }]);
	await BaseItem.markAllNonEncryptedForSync();
	assert.deepEqual(events, ['persist', 'notify']);
	assert.equal(BaseItem.localChangeGeneration(), generation + 1);
	generation++;

	setDatabasePersistence(async () => { throw new Error('database write failed'); });
	events.length = 0;
	await assert.rejects(BaseItem.forceSync('failed'));
	assert.deepEqual(events, []);
	assert.equal(BaseItem.localChangeGeneration(), generation, 'failed force-sync writes do not advance local generation');
	BaseItem.setLocalChangeHandler(null);
});
