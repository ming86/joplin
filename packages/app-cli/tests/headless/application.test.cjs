const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');

// Exercise the real application wiring with fake Joplin workers. These are not sync integration tests.
function fixture() {
	const events = [];
	const settingValues = {
		'sync.target': 9,
		'sync.9.username': 'server@example.invalid',
		'sync.10.username': 'cloud-internal-user-id',
		'sync.10.userEmail': 'cloud@example.invalid',
	};
	class Base {
		store() { return { getState: () => ({
			syncStarted: false, syncPending: true, syncReport: { errors: [] },
			notLoadedMasterKeys: [], decryptionWorker: { state: 'idle' },
		}) }; }
		createDatabaseDriver() { return 'stock-driver'; }
		backgroundServicesEnabled() { return false; }
		async applySettingsSideEffects() { events.push(`background:${this.backgroundServicesEnabled()}`); }
		deinitRedux() { events.push('detach-redux'); }
		async destroy() { events.push('stop-workers'); await this.onServicesStopped(); events.push('reset-models'); }
	}
	class Logger { setLevel() {} }
	class Driver { constructor(key) { this.key = key; } }
	const instance = {
		initialize(actions) { this.actions = actions; }, setLogger() {}, setDispatch() {},
		async start(options) { assert.equal(options.returnWhenListening, true); events.push('listen'); },
		async stop(options) { assert.equal(options.graceful, true); events.push('drain-api'); },
	};
	const empty = {};
	const mocks = Object.fromEntries([
		'@joplin/lib/folders-screen-utils.js', '@joplin/lib/BaseModel', '@joplin/lib/models/Folder',
		'@joplin/lib/models/BaseItem', '@joplin/lib/Synchronizer', './headless/HeadlessSyncScheduler', '@joplin/lib/models/Note', '@joplin/lib/models/Tag',
		'@joplin/lib/path-utils', '@joplin/lib/locale', 'fs-extra', '@joplin/lib/shim',
		'./setupCommand', './base-command', './utils/initializeCommandService', './cli-utils',
		'./headless/config', './headless/profile', 'proper-lockfile',
	].map(name => [name, empty]));
	Object.assign(mocks, {
		'@joplin/lib/BaseApplication': Base,
		'@joplin/lib/Cache': class {},
		'@joplin/lib/models/BaseItem': { setLocalChangeHandler: handler => events.push(handler ? 'attach-local-sync' : 'detach-local-sync') },
		'@joplin/utils/Logger': Logger,
		'./headless/DatabaseDriver': Driver,
		'./headless/revisions': { createHeadlessRevisionActions: () => ({}) },
		'./headless/maintenance': { createHeadlessMaintenanceActions: () => ({}) },
		'./headless/attachments': { default: () => ({}), __esModule: true },
		'./headless/conflicts': () => ({}),
		'./headless/status': load('packages/app-cli/app/headless/status.ts'),
		'@joplin/lib/ClipperServer': { instance: () => instance },
		'@joplin/lib/services/DecryptionWorker': { instance: () => ({
			scheduleStart: async () => events.push('decrypt'),
			decryptionDisabledItems: async () => [{ id: 'never-exposed' }],
		}) },
		'@joplin/lib/services/search/SearchEngine': { instance: () => ({ syncTables: async () => events.push('fts') }) },
		'@joplin/lib/services/ResourceService': { runInBackground: () => events.push('resources') },
		'@joplin/lib/services/RevisionService': { instance: () => ({ runInBackground: () => events.push('revisions') }) },
		'@joplin/lib/models/Setting': {
			value: key => settingValues[key],
			saveAll: async () => events.push('save-settings'),
			cancelScheduleSave: () => events.push('cancel-settings-timer'),
		},
		'@joplin/lib/registry.js': { reg: {
			scheduleSync: async () => events.push('schedule-sync'),
			setSyncSchedulingPolicy: factory => events.push(factory ? 'attach-sync-policy' : 'detach-sync-policy'),
			syncSchedulingPending: () => false,
			cancelTimers: async () => events.push('cancel-sync-timers'),
			syncTarget: () => ({ syncStarted: async () => true, synchronizer: async () => ({
				cancel: async () => events.push('cancel-sync'),
				waitForSyncToFinish: async () => events.push('drain-sync'),
			}) }),
		} },
		'./headless/runService': { runService: async operations => {
			await operations.start(); operations.ready(); await operations.stop();
		} },
	});
	const { Application } = load('packages/app-cli/app/app.ts', mocks);
	const app = new Application();
	app.stdout = () => events.push('ready');
	app.database_ = { close: async () => events.push('close-db') };
	return { app, events, Driver, clipper: instance, settingValues };
}

test('headless application wires one owner: initialize, listen, drain sync/workers, flush and close', async () => {
	const { app, events, clipper, settingValues } = fixture();
	app.headlessConfig_ = { databaseKey: Buffer.alloc(32) };
	app.headlessInitialized_ = true;
	await app.runHeadlessService();
	assert.deepEqual(events, [
		'attach-sync-policy', 'attach-local-sync', 'background:true', 'decrypt', 'fts', 'resources', 'revisions', 'save-settings',
		'listen', 'schedule-sync', 'ready', 'detach-local-sync', 'drain-api', 'cancel-sync-timers', 'cancel-sync',
		'drain-sync', 'detach-sync-policy', 'detach-redux', 'stop-workers', 'save-settings', 'cancel-settings-timer',
		'close-db', 'reset-models',
	]);
	assert.equal(app.backgroundServicesEnabled(), false);
	const summary = await clipper.actions.headless().status();
	assert.equal(summary.sync.pending, false);
	assert.equal(summary.accountEmail, 'server@example.invalid');
	assert.equal(summary.decryption.disabledItemCount, 1);
	assert.ok(!JSON.stringify(summary).includes('never-exposed'));
	settingValues['sync.target'] = 10;
	assert.equal((await clipper.actions.headless().status()).accountEmail, 'cloud@example.invalid');
	settingValues['sync.target'] = 6;
	assert.equal((await clipper.actions.headless().status()).accountEmail, null);
	await app.stopHeadless();
	assert.equal(events.filter(value => value === 'close-db').length, 1);
});

test('headless driver is opt-in and standard CLI cannot accidentally invoke the daemon', async () => {
	const { app, Driver, clipper } = fixture();
	assert.equal(app.createDatabaseDriver(), 'stock-driver');
	await assert.rejects(app.runHeadlessService(), /JOPLIN_HEADLESS=1/);
	assert.equal(clipper.actions, undefined);
	const key = Buffer.alloc(32);
	app.headlessConfig_ = { databaseKey: key };
	const driver = app.createDatabaseDriver();
	assert.ok(driver instanceof Driver);
	assert.equal(driver.key, key);
});
