const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');

/** Runs the command implementations while isolating unrelated application services. */
function commandHarness({ headless = true, startSync, startDecryption, authenticated = true, lockError } = {}) {
	const output = [];
	const calls = { released: 0, fetched: 0, refreshed: 0, cleared: 0, syncOptions: [], decryptionOptions: [] };
	const settings = { 'sync.target': 2, profileDir: '/profile', 'sync.upgradeState': 0 };
	class BaseCommand {
		stdout(line) { output.push(line); }
		async prompt() { throw new Error('Unexpected prompt'); }
	}
	const app = {
		gui: () => ({ showConsole() {}, maximizeConsole() {} }),
		hasGui: () => false,
		async refreshCurrentFolder() { calls.refreshed++; },
	};
	const sync = {
		async start(options) {
			calls.syncOptions.push(options);
			if (startSync) return startSync(options);
			options.onProgress({ errors: [] });
			return { delta: 'next' };
		},
	};
	const common = {
		'./base-command': BaseCommand,
		'@joplin/lib/locale': { _: (line, ...values) => line.replace(/%[sd]/g, () => String(values.shift())) },
		'@joplin/lib/models/Setting': {
			value: name => name === 'isHeadless' ? headless : settings[name],
			setValue: (name, value) => { settings[name] = value; },
			enumOptionLabel: () => 'Target',
			SYNC_UPGRADE_STATE_IDLE: 0,
		},
		'@joplin/lib/services/e2ee/utils': { masterKeysWithoutPassword: async () => [] },
	};
	const SyncCommand = load('packages/app-cli/app/command-sync.ts', {
		...common,
		'./app': () => app,
		'./cli-utils.js': { cliUtils: { redraw() {}, redrawDone() {} } },
		'@joplin/lib/SyncTargetRegistry': { idToMetadata: () => ({ name: 'filesystem', label: 'Target' }) },
		'@joplin/lib/services/synchronizer/MigrationHandler': {},
		'@joplin/lib/services/ResourceFetcher': { instance: () => ({ async fetchAll() { calls.fetched++; }, async waitForAllFinished() {} }) },
		'@joplin/lib/Synchronizer': { reportToLines: () => [] },
		'@joplin/lib/services/synchronizer/LockHandler': {},
		'@joplin/lib/onedrive-api-node-utils': {},
		'@joplin/lib/registry': { reg: { syncTarget: () => ({ isAuthenticated: async () => authenticated, synchronizer: async () => sync }) } },
		md5: () => 'profile-hash',
		'proper-lockfile': { check: async () => false, lock: async () => { if (lockError) throw lockError; return () => { calls.released++; }; } },
		'fs-extra': { pathExists: async () => true },
		'@joplin/lib/services/joplinCloudUtils': {},
		'@joplin/utils/Logger': { create: () => ({}) },
		'@joplin/lib/uuid': {},
		'@joplin/lib/services/share/ShareService': { instance: () => ({ maintenance: async () => {} }) },
		'@joplin/lib/SyncTargetOneDrive': {},
		'@joplin/lib/SyncTargetDropbox': {},
	});
	const E2eeCommand = load('packages/app-cli/app/command-e2ee.ts', {
		...common,
		'@joplin/lib/services/e2ee/EncryptionService': {},
		'@joplin/lib/services/DecryptionWorker': { instance: () => ({
			async start(options) {
				calls.decryptionOptions.push(options);
				return startDecryption ? startDecryption(options) : { decryptedItemCount: 2, skippedItemCount: 0 };
			},
			async clearDisabledItems() { calls.cleared++; },
		}) },
		'@joplin/lib/models/BaseItem': {},
		'@joplin/lib/shim': {},
		'@joplin/lib/path-utils': {},
		'@joplin/lib/services/synchronizer/syncInfoUtils': {},
		'file-type': {},
	});
	return { sync: new SyncCommand(), e2ee: new E2eeCommand(), calls, output, settings };
}

for (const code of ['failSafe', 'ETIMEDOUT', 'alreadyStarted']) {
	test(`headless sync rejects ${code} without downloading resources`, async () => {
		const error = Object.assign(new Error('sync failure'), { code });
		const { sync, calls } = commandHarness({ startSync: async options => {
			assert.equal(options.throwOnError, true);
			throw error;
		} });
		await assert.rejects(sync.action({ options: {} }), cause => cause === error);
		assert.equal(calls.released, 1);
		assert.equal(calls.fetched, 0);
	});
}

test('headless sync rejects structured report failures and preserves the first cause', async () => {
	const error = new Error('publication failed');
	const { sync, calls } = commandHarness({ startSync: async options => {
		options.onProgress({ errors: [] });
		options.onProgress({ errors: [error, 'rejected item'] });
		return {};
	} });
	await assert.rejects(sync.action({ options: {} }), cause => cause === error);
	assert.equal(calls.released, 1);
	assert.equal(calls.fetched, 0);
});

test('headless sync rejects a report containing a string error', async () => {
	const { sync } = commandHarness({ startSync: async options => {
		options.onProgress({ errors: ['malformed item'] });
		return {};
	} });
	await assert.rejects(sync.action({ options: {} }), /malformed item/);
});

test('headless sync rejects unsuccessful authentication and local lock contention', async () => {
	const unauthenticated = commandHarness({ authenticated: false });
	await assert.rejects(unauthenticated.sync.action({ options: {} }), /authentication was not completed/);
	assert.equal(unauthenticated.calls.syncOptions.length, 0);
	assert.equal(unauthenticated.calls.released, 1);
	const error = Object.assign(new Error('locked'), { code: 'ELOCKED', file: '/lock' });
	const locked = commandHarness({ lockError: error });
	await assert.rejects(locked.sync.action({ options: {} }), cause => cause === error);
	assert.equal(locked.calls.syncOptions.length, 0);
});

test('successful headless sync saves context and completes the existing resource workflow', async () => {
	const { sync, calls, settings } = commandHarness();
	await sync.action({ options: {} });
	assert.equal(settings['sync.2.context'], '{"delta":"next"}');
	assert.equal(calls.fetched, 1);
	assert.equal(calls.refreshed, 1);
	assert.equal(calls.released, 1);
});

test('ordinary CLI sync retains report-only and already-started behavior', async () => {
	for (const alreadyStarted of [false, true]) {
		const { sync, calls } = commandHarness({ headless: false, startSync: async options => {
			assert.equal(options.throwOnError, false);
			if (alreadyStarted) throw Object.assign(new Error('already running'), { code: 'alreadyStarted' });
			options.onProgress({ errors: [new Error('reported')] });
			return {};
		} });
		await sync.action({ options: {} });
		assert.equal(calls.fetched, 1);
	}
});

test('headless decryption throws item failures and never prints completion', async () => {
	const error = new Error('invalid encrypted item');
	const { e2ee, output } = commandHarness({ startDecryption: async options => {
		assert.equal(options.errorHandler, 'throw');
		throw error;
	} });
	await assert.rejects(e2ee.action({ command: 'decrypt', options: { force: true } }), cause => cause === error);
	assert.equal(output.includes('Completed decryption.'), false);
});

test('headless decryption rejects previously disabled failures', async () => {
	const { e2ee, output } = commandHarness({ startDecryption: async () => ({ decryptedItemCount: 1, skippedItemCount: 2 }) });
	await assert.rejects(e2ee.action({ command: 'decrypt', options: { force: true } }), /skipped 2 items disabled after repeated failures/);
	assert.equal(output.includes('Completed decryption.'), false);
});

test('successful headless decryption completes and can retry disabled items', async () => {
	const { e2ee, output, calls } = commandHarness();
	await e2ee.action({ command: 'decrypt', options: { force: true, 'retry-failed-items': true } });
	assert.equal(calls.cleared, 1);
	assert.deepEqual(calls.decryptionOptions, [{ errorHandler: 'throw' }]);
	assert.equal(output.includes('Completed decryption.'), true);
});

test('ordinary CLI decryption retains log-handler defaults and skipped-item completion', async () => {
	const { e2ee, output, calls } = commandHarness({ headless: false, startDecryption: async () => ({ decryptedItemCount: 1, skippedItemCount: 2 }) });
	await e2ee.action({ command: 'decrypt', options: {} });
	assert.deepEqual(calls.decryptionOptions, [{}]);
	assert.equal(output.includes('Completed decryption.'), true);
});
