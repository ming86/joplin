const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');
const { summarizeHeadlessState, createHeadlessActionApi, getHeadlessAccountEmail } = load('packages/app-cli/app/headless/status.ts');

/** Supply only the Redux fields read by the status boundary. */
function state() {
	return {
		syncStarted: false, syncPending: false, syncReport: { errors: [] },
		notLoadedMasterKeys: [],
		decryptionWorker: { state: 'idle', itemIndex: 0, itemCount: 0 },
	};
}

test('status distinguishes an absent report, live activity, and the retained report', () => {
	const current = state();
	assert.equal(summarizeHeadlessState(current, 0, 100).sync.report, null);
	current.syncReport = {
		startTime: 1000, completedTime: 2000, state: 'in_progress', createLocal: 4,
		fetchingTotal: 8, fetchingProcessed: 6, updateRemote: Infinity, deleteRemote: -1,
		errors: [new Error('secret note title /profile/path https://private.example password')],
		backendMessage: 'secret', noteTitle: 'secret',
	};
	current.syncPending = true;
	const summary = summarizeHeadlessState(current, 2, 100);
	assert.equal(summary.accountEmail, null);
	assert.deepEqual(summary.sync, {
		running: false, pending: true, kind: null, lastPeriodicFullSync: null,
		report: { state: 'in_progress', startTime: 1000, completedTime: 2000,
			counters: { createLocal: 4, fetchingTotal: 8, fetchingProcessed: 6 }, errorCount: 1 },
	});
	assert.equal(summary.serviceStartedAt, 100);
	assert.ok(summary.observedAt >= 100);
	assert.ok(!JSON.stringify(summary).includes('secret'));
	current.syncReport.createLocal = 5;
	assert.equal(summary.sync.report.counters.createLocal, 4);
});

test('status reads live scheduler observations independently of Redux and copies periodic timing', async () => {
	const schedulerStatus = { kind: 'full', lastPeriodicFullSync: { startTime: 1000, completedTime: null } };
	const actions = createHeadlessActionApi(state, async () => 0, async () => null, {}, () => schedulerStatus);
	const active = await actions.headless().status();
	assert.equal(active.sync.running, false, 'scheduler preparation can precede the Redux running flag');
	assert.equal(active.sync.kind, 'full');
	assert.deepEqual(active.sync.lastPeriodicFullSync, { startTime: 1000, completedTime: null });
	schedulerStatus.kind = null;
	schedulerStatus.lastPeriodicFullSync.completedTime = 2000;
	assert.equal(active.sync.lastPeriodicFullSync.completedTime, null);
	const settled = await actions.headless().status();
	assert.equal(settled.sync.kind, null);
	settled.sync.lastPeriodicFullSync.startTime = -1;
	assert.equal(schedulerStatus.lastPeriodicFullSync.startTime, 1000);
});

test('decryption exposes only the active batch and existing missing-key and disabled-record indicators', () => {
	const current = state();
	current.notLoadedMasterKeys = ['private-key-id'];
	current.decryptionWorker = { state: 'started', itemIndex: 2, itemCount: 10, skippedItemCount: 99 };
	assert.deepEqual(summarizeHeadlessState(current, 3, 100).decryption, {
		state: 'started', batch: { itemIndex: 2, itemCount: 10 }, missingMasterKey: true, disabledItemCount: 3,
	});
	current.decryptionWorker.state = 'idle';
	assert.equal(summarizeHeadlessState(current, 3, 100).decryption.batch, null);
});

test('status resolves the authenticated Joplin Server profile email instead of the login ID', async () => {
	for (const targetId of [9, 10, 11]) {
		const calls = [];
		const api = {
			userId: 'server-owner-uuid',
			async loadSession() { calls.push('loadSession'); },
			async exec(method, path) {
				calls.push([method, path]);
				return { email: 'owner@example.invalid' };
			},
		};

		assert.equal(await getHeadlessAccountEmail(targetId, async () => api), 'owner@example.invalid');
		assert.deepEqual(calls, ['loadSession', ['GET', 'api/users/server-owner-uuid']]);
	}
});

test('status returns null for unsupported sync targets without creating a server API', async () => {
	let apiCreated = false;
	assert.equal(await getHeadlessAccountEmail(6, async () => {
		apiCreated = true;
		throw new Error('should not be called');
	}), null);
	assert.equal(apiCreated, false);
});

/** Use the real REST router and authentication with unrelated entity routes isolated. */
function api(actionApi) {
	class HttpError extends Error {}
	const routes = ['folders', 'notes', 'resources', 'tags', 'master_keys', 'search', 'ping', 'auth', 'events', 'revisions', 'mcp'];
	const mocks = Object.fromEntries(routes.map(name => [`./routes/${name}`, {}]));
	Object.assign(mocks, {
		'../../BaseModel': { UserSideValidationError: class UserSideValidationError extends Error {} },
		'../../models/utils/types': {},
		'./utils/errors': {
			ErrorMethodNotAllowed: HttpError,
			ErrorForbidden: HttpError,
			ErrorBadRequest: HttpError,
			ErrorNotFound: HttpError,
			ErrorValidation: HttpError,
		},
		'../../path-utils': { ltrimSlashes: value => value.replace(/^\/+/, '') },
		md5: () => '',
	});
	const Api = load('packages/lib/services/rest/Api.ts', mocks).default;
	return new Api('private-token', null, actionApi);
}

test('fixed headless status action uses REST token authentication and excludes other actions', async () => {
	let reads = 0;
	const extraActions = {
		status: async () => ({ overridden: true }),
		probe: async () => ({ registered: true }),
	};
	const actions = createHeadlessActionApi(state, async () => { reads++; return 2; }, () => null, extraActions);
	assert.equal(Object.getPrototypeOf(actions), null);
	assert.equal(Object.getPrototypeOf(actions.headless()), null);
	const router = api(actions);
	const body = JSON.stringify({ action: 'status' });
	await assert.rejects(router.route('POST', 'services/headless', {}, body), /Missing "token"/);
	await assert.rejects(router.route('POST', 'services/headless', { token: 'wrong' }, body), /Invalid "token"/);
	assert.equal(reads, 0);
	const summary = await router.route('POST', 'services/headless', { token: 'private-token' }, body);
	assert.equal(summary.decryption.disabledItemCount, 2);
	assert.equal(summary.accountEmail, null);
	assert.equal(reads, 1);
	const probe = await router.route('POST', 'services/headless', { token: 'private-token' }, JSON.stringify({ action: 'probe' }));
	assert.deepEqual(probe, { registered: true });
	for (const action of ['start', 'toString', 'constructor']) {
		await assert.rejects(router.route('POST', 'services/headless', { token: 'private-token' }, JSON.stringify({ action })), /Invalid action/);
	}
	await assert.rejects(api().route('POST', 'services/headless', { token: 'private-token' }, body), /No action API/);
	await assert.rejects(router.route('GET', 'services/headless', { token: 'private-token' }, body));
});

test('profile lookup failures remain generic through the status action', async () => {
	const actions = createHeadlessActionApi(state, async () => 0, () => getHeadlessAccountEmail(9, async () => ({
		userId: 'owner-uuid',
		async loadSession() {},
		async exec() { throw new Error('lookup failed: /private/profile'); },
	})));
	await assert.rejects(actions.headless().status(), { message: 'Headless status unavailable.' });
});
