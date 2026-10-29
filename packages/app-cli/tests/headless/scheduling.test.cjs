const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(shimOverride = null) {
	const intervals = new Set(); const timeouts = new Set(); const calls = [];
	const settings = { 'sync.target': 9, 'sync.interval': 300, env: 'prod', 'sync.9.context': '{}' };
	class Logger { info() {} debug() {} warn() {} }
	const fakeSync = { fail: false, async start(options) { calls.push(options); if (this.fail) throw new Error('synthetic network outage'); return { cursor: calls.length }; } };
	const shim = {
		isElectron: () => false,
		setInterval(fn, ms) { const timer = { fn, ms }; intervals.add(timer); return timer; },
		clearInterval: timer => intervals.delete(timer),
		setTimeout(fn, ms) { const timer = { fn, ms }; timeouts.add(timer); return timer; },
		clearTimeout: timer => timeouts.delete(timer),
	};
	const { reg } = load('packages/lib/registry.ts', {
		'@joplin/utils/Logger': Logger,
		'./models/Setting': { value: key => settings[key], setValue: (key, value) => { settings[key] = value; } },
		'./shim': shimOverride || shim, './SyncTargetRegistry': {},
		'./Synchronizer': { partialSyncSteps: ['update_remote'] },
	});
	reg.syncTarget = () => ({ isAuthenticated: async () => true, synchronizer: async () => fakeSync });
	return { reg, fakeSync, settings, calls, intervals, timeouts };
}

test('production recurrent scheduling retries after a synchronization failure without restarting the owner', async () => {
	const { reg, fakeSync, calls, intervals, settings } = fixture();
	fakeSync.fail = true;
	await reg.scheduleSync(0); await turn();
	assert.equal(calls.length, 1);
	assert.equal(intervals.size, 1); assert.equal([...intervals][0].ms, 300000);
	fakeSync.fail = false;
	[...intervals][0].fn(); await turn();
	assert.equal(calls.length, 2);
	assert.equal(JSON.parse(settings['sync.9.context']).cursor, 2);
	assert.equal(intervals.size, 1);
});

test('native background failures reach the observer with their original error without rejecting the scheduled operation', async () => {
	const { reg, fakeSync } = fixture();
	const observed = [];
	const error = Object.assign(new Error('synthetic network outage'), { code: 'ECONNRESET' });
	fakeSync.start = async () => { throw error; };
	await reg.scheduleSync(0, { onError: (...args) => observed.push(args) });
	assert.deepEqual(observed, [[error, 'synchronize']]);
	const initializationError = new Error('synchronizer initialization failed');
	reg.syncTarget = () => ({ isAuthenticated: async () => true, synchronizer: async () => { throw initializationError; } });
	await reg.scheduleSync(0, { onError: (...args) => observed.push(args) });
	assert.deepEqual(observed[1], [initializationError, 'initialize-synchronizer']);
});

test('cancelling registry timers drains callbacks and clears the cancellation polling timer', async () => {
	const { reg, intervals } = fixture();
	reg.setupRecurrentSync(); assert.equal(intervals.size, 1);
	const stopped = reg.cancelTimers();
	assert.equal(intervals.size, 1); assert.equal([...intervals][0].ms, 100);
	[...intervals][0].fn(); await stopped;
	assert.equal(intervals.size, 0);
});

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

// Drive the real registry policy and native execution wrapper with deterministic virtual time.
function headlessFixture(t, intervalMs = 10000) {
	let now = 0;
	const originalNow = Date.now;
	Date.now = () => now;
	t.after(() => { Date.now = originalNow; });
	const timers = new Set();
	const shim = {
		isElectron: () => false,
		setTimeout(fn, ms) { const timer = { fn, due: now + ms, delay: ms }; timers.add(timer); return timer; },
		clearTimeout: timer => timers.delete(timer),
		setInterval(fn, ms) { const timer = { fn, due: now + ms, interval: ms }; timers.add(timer); return timer; },
		clearInterval: timer => timers.delete(timer),
	};
	const output = fixture(shim);
	const Scheduler = load('packages/app-cli/app/headless/HeadlessSyncScheduler.ts', {
		'@joplin/lib/Synchronizer': { partialSyncSteps: ['update_remote'] },
		'@joplin/lib/shim': shim,
	}).default;
	const errors = [];
	let scheduler;
	output.reg.setSyncSchedulingPolicy((run, pendingChanged) => {
		scheduler = new Scheduler(run, pendingChanged, intervalMs, error => errors.push(error));
		return scheduler;
	});
	output.reg.setupRecurrentSync();
	t.after(() => output.reg.setSyncSchedulingPolicy(null));
	return {
		...output, timers, errors, scheduler,
		async advance(ms) {
			const end = now + ms;
			for (;;) {
				const next = [...timers].filter(timer => timer.due <= end).sort((a, b) => a.due - b.due)[0];
				if (!next) break;
				now = next.due;
				if (next.interval) next.due += next.interval;
				else timers.delete(next);
				next.fn();
				await turn();
			}
			now = end;
			await turn();
		},
	};
}

const partialOptions = { syncSteps: ['update_remote'] };

test('scheduler kind follows active execution through authentication and returns to null when idle', async t => {
	const { reg, fakeSync, advance, scheduler } = headlessFixture(t);
	assert.deepEqual(scheduler.status, { kind: null, lastPeriodicFullSync: null });
	for (const [kind, options] of [['full', {}], ['upload', partialOptions], ['poll', { remoteChangesOnly: true }]]) {
		const authentication = deferred();
		const execution = deferred();
		reg.syncTarget = () => ({ isAuthenticated: async () => { await authentication.promise; return true; }, synchronizer: async () => fakeSync });
		fakeSync.start = async () => { await execution.promise; };
		const scheduled = reg.scheduleSync(100, options);
		assert.equal(scheduler.status.kind, null, 'queued work is not active execution');
		await advance(100);
		assert.equal(scheduler.status.kind, kind, 'authentication is part of scheduler execution');
		authentication.resolve(); await turn();
		assert.equal(scheduler.status.kind, kind);
		execution.resolve(); await scheduled;
		assert.equal(scheduler.status.kind, null);
		assert.equal(scheduler.status.lastPeriodicFullSync, null, 'ordinary full requests are not periodic');
	}
});

test('headless registry keeps its remote-check cadence independent of repeated local saves', async t => {
	const { reg, calls, advance, timers, settings } = headlessFixture(t);
	const startup = reg.scheduleSync(0);
	await advance(0); await startup;
	for (let i = 0; i < 20; i++) {
		void reg.scheduleSync(1000, partialOptions);
		await advance(500);
	}
	assert.equal(calls.length, 2);
	assert.equal(calls[1].syncSteps, undefined, 'periodic full sync subsumes the debounced partial');
	assert.equal(calls[1].remoteChangesOnly, undefined);
	assert.equal([...timers].filter(timer => timer.delay === 10000).length, 1);
	assert.equal(settings['sync.interval'], 300, 'normal client cadence is not rewritten');
	assert.deepEqual(JSON.parse(settings['sync.9.context']), { cursor: 2 });
});

test('edits during native sync coalesce and retain the remaining debounce after completion', async t => {
	const { reg, fakeSync, calls, advance } = headlessFixture(t);
	const running = deferred();
	fakeSync.start = async options => { calls.push(options); await running.promise; return {}; };
	const startup = reg.scheduleSync(0);
	await advance(0);
	void reg.scheduleSync(1000, partialOptions);
	await advance(600);
	void reg.scheduleSync(1000, partialOptions);
	await advance(200);
	assert.equal(calls.length, 1);
	assert.equal(reg.syncSchedulingPending(), true);
	running.resolve(); await startup; await turn();
	await advance(799); assert.equal(calls.length, 1);
	await advance(1); assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].syncSteps, partialOptions.syncSteps);
	assert.equal(reg.syncSchedulingPending(), false);
});

test('remote checks pause during a full sync without losing a debounced upload followup', async t => {
	const { reg, fakeSync, calls, advance } = headlessFixture(t);
	const running = deferred();
	fakeSync.start = async options => { calls.push(options); await running.promise; return {}; };
	const startup = reg.scheduleSync(0);
	await advance(0);
	await advance(30000);
	void reg.scheduleSync(1000, partialOptions);
	assert.equal(calls.length, 1);
	running.resolve(); await startup; await turn();
	await advance(999);
	assert.equal(calls.length, 1, 'a full sync suppresses polls while it is active');
	await advance(1);
	assert.equal(calls.length, 2, 'the debounced upload still runs after the full sync');
	assert.deepEqual(calls[1].syncSteps, partialOptions.syncSteps);
});

test('remote checks wait 15 seconds after the previous check completes', async t => {
	const { reg, fakeSync, calls, advance } = headlessFixture(t, 15000);
	const startup = reg.scheduleSync(0);
	await advance(0); await startup;
	const poll = deferred();
	fakeSync.start = async options => {
		calls.push(options);
		if (options.remoteChangesOnly) await poll.promise;
	};

	await advance(15000);
	assert.equal(calls.filter(options => options.remoteChangesOnly).length, 1);
	await advance(30000);
	assert.equal(calls.filter(options => options.remoteChangesOnly).length, 1, 'a slow check does not overlap or queue another poll');
	poll.resolve();
	await advance(0);
	await advance(14999);
	assert.equal(calls.filter(options => options.remoteChangesOnly).length, 1);
	await advance(1);
	assert.equal(calls.filter(options => options.remoteChangesOnly).length, 2, 'the next check starts 15 seconds after completion');
});

test('remote checks remain paused through a periodic full sync and restart after it settles', async t => {
	const { reg, calls, advance, timers } = headlessFixture(t);
	const startup = reg.scheduleSync(0);
	await advance(0); await startup;
	assert.equal([...timers].filter(timer => timer.interval).length, 0, 'remote checks use one-shot timers');
	assert.deepEqual([...timers].map(timer => timer.delay).sort((a, b) => a - b), [10000, 120000]);

	await advance(10000);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].remoteChangesOnly, true);
	await advance(109999);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 1, 'polls do not reset the periodic full-sync clock');
	await advance(1);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 2, 'the ordinary full sync still runs at 120 seconds');
	assert.equal(calls[calls.length - 1].remoteChangesOnly, undefined);
	assert.equal([...timers].find(timer => timer.delay === 120000).due, 240000, 'the next delay begins when that full sync settles');
	assert([...timers].some(timer => timer.delay === 10000 && timer.due === 130000), 'remote checks restart after the full sync completes');
});

test('periodic full sync delay restarts 120 seconds after success or failure settles', async t => {
	const { reg, fakeSync, calls, advance, timers, scheduler } = headlessFixture(t);
	const startup = reg.scheduleSync(0);
	await advance(0); await startup;
	const periodicFull = deferred();
	const failedPeriodicFull = deferred();
	let fullRuns = 0;
	fakeSync.start = async options => {
		calls.push(options);
		if (!options.remoteChangesOnly) {
			fullRuns++;
			if (fullRuns === 1) await periodicFull.promise;
			if (fullRuns === 2) {
				await failedPeriodicFull.promise;
				throw new Error('periodic full sync failed');
			}
		}
		return {};
	};

	await advance(120000);
	assert.deepEqual(scheduler.status, { kind: 'full', lastPeriodicFullSync: { startTime: 120000, completedTime: null } });
	const activeSnapshot = scheduler.status;
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 2, 'the first periodic full sync starts after its delay');
	await advance(120000);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 2, 'a full sync still running does not queue another full sync');
	assert.equal(calls.filter(options => options.remoteChangesOnly).length, 11, 'remote checks stay suspended while the full sync is running');

	periodicFull.resolve();
	await advance(0);
	assert.deepEqual(scheduler.status, { kind: null, lastPeriodicFullSync: { startTime: 120000, completedTime: 240000 } });
	assert.equal(activeSnapshot.lastPeriodicFullSync.completedTime, null, 'snapshots do not change when execution settles');
	scheduler.status.lastPeriodicFullSync.startTime = -1;
	assert.equal(scheduler.status.lastPeriodicFullSync.startTime, 120000, 'callers cannot mutate scheduler timing');
	await advance(119999);
	assert.deepEqual(scheduler.status.lastPeriodicFullSync, { startTime: 120000, completedTime: 240000 }, 'intervening polls retain the periodic timing');
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 2, 'the next delay starts after the slow full sync finishes');
	await advance(1);
	assert.deepEqual(scheduler.status.lastPeriodicFullSync, { startTime: 360000, completedTime: null });
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 3, 'the next full sync starts 120 seconds after successful completion');

	await advance(120000);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 3, 'the next full sync does not start while the failed run is active');
	assert.equal(calls.filter(options => options.remoteChangesOnly).length, 22, 'remote checks remain suspended during that full sync');
	failedPeriodicFull.resolve();
	await advance(0); await turn();
	assert.deepEqual(scheduler.status, { kind: null, lastPeriodicFullSync: { startTime: 360000, completedTime: 480000 } }, 'failed native synchronization still settles its scheduler execution');
	assert([...timers].some(timer => timer.delay === 10000 && timer.due === 490000), 'the poll delay restarts after the failed full sync settles');
	assert([...timers].some(timer => timer.delay === 120000 && timer.due === 600000), 'the next full-sync delay also starts after failure settles');
	await advance(119999);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 3, 'failure does not trigger an immediate full-sync retry');
	await advance(1);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 4, 'the next periodic full sync still starts 120 seconds after failure settles');
});

test('a remote poll and a queued local upload merge into an ordinary full sync', async t => {
	const { reg, calls, advance, scheduler } = headlessFixture(t);
	const startup = reg.scheduleSync(0);
	await advance(0); await startup;
	await advance(9000);
	const upload = reg.scheduleSync(5000, partialOptions);
	await advance(1000);
	await upload;
	assert.equal(calls.length, 2);
	assert.equal(calls[1].syncSteps, undefined);
	assert.equal(calls[1].remoteChangesOnly, undefined);
	assert.equal(scheduler.status.lastPeriodicFullSync, null, 'promotion to full does not make a request periodic');
});

test('periodic identity survives coalescing and starts timing only when the queued request executes', async t => {
	const { reg, fakeSync, advance, scheduler } = headlessFixture(t);
	const running = deferred();
	fakeSync.start = async () => { await running.promise; return {}; };
	const startup = reg.scheduleSync(0);
	await advance(0);
	await advance(119000);
	const ordinaryFull = reg.scheduleSync(0);
	const upload = reg.scheduleSync(1000, partialOptions);
	await advance(6000);
	assert.equal(scheduler.status.kind, 'full');
	assert.equal(scheduler.status.lastPeriodicFullSync, null, 'the periodic timer queued work but execution is still waiting');
	running.resolve(); await startup;
	await advance(0); await ordinaryFull; await upload;
	const expected = { startTime: 125000, completedTime: 125000 };
	assert.deepEqual(scheduler.status.lastPeriodicFullSync, expected, 'the periodic request joined an existing full request');
	for (const options of [partialOptions, {}, { remoteChangesOnly: true }]) {
		const next = reg.scheduleSync(0, options);
		await advance(0); await next;
		assert.deepEqual(scheduler.status.lastPeriodicFullSync, expected, 'other requests retain the most recent periodic timing');
	}
});

test('periodic authentication rejection records completion without claiming successful synchronization', async t => {
	const { reg, advance, errors, scheduler } = headlessFixture(t, 200000);
	const authentication = deferred();
	reg.syncTarget = () => ({ isAuthenticated: async () => { await authentication.promise; throw new Error('authentication unavailable'); } });
	await advance(120000);
	assert.deepEqual(scheduler.status.lastPeriodicFullSync, { startTime: 120000, completedTime: null });
	await advance(5000);
	authentication.resolve(); await turn();
	assert.deepEqual(scheduler.status, { kind: null, lastPeriodicFullSync: { startTime: 120000, completedTime: 125000 } });
	assert.equal(errors.length, 1);
});

test('native failure does not self-requeue, while a new edit during failure remains scheduled', async t => {
	const { reg, fakeSync, calls, advance } = headlessFixture(t);
	fakeSync.fail = true;
	const first = reg.scheduleSync(0);
	await advance(0); await first;
	await advance(9999); assert.equal(calls.length, 1);
	await advance(1); assert.equal(calls.length, 2, 'normal periodic retry remains active');
	const running = deferred();
	fakeSync.start = async options => { calls.push(options); await running.promise; throw new Error('network failure'); };
	const failed = reg.scheduleSync(0);
	await advance(0);
	void reg.scheduleSync(1000, partialOptions);
	running.resolve(); await failed; await turn();
	await advance(999); assert.equal(calls.length, 3);
	await advance(1); assert.equal(calls.length, 4, 'new edit is not discarded with the failed request');
	await advance(1); assert.equal(calls.length, 4);
});

test('headless shutdown clears debounce and ticks and prevents active-run followups restarting timers', async t => {
	const { reg, fakeSync, calls, advance, timers } = headlessFixture(t);
	const running = deferred();
	fakeSync.start = async options => { calls.push(options); await running.promise; void reg.scheduleSync(1000, partialOptions); return {}; };
	const startup = reg.scheduleSync(0);
	await advance(0);
	void reg.scheduleSync(1000, partialOptions);
	const stopped = reg.cancelTimers();
	assert.equal(reg.syncSchedulingPending(), false);
	running.resolve(); await startup; await turn();
	await advance(100); await stopped;
	assert.equal(timers.size, 0);
	await advance(30000); assert.equal(calls.length, 1);
});


test('periodic authentication failure is reported without an unhandled rejection or immediate retry', async t => {
	const { reg, advance, errors, calls } = headlessFixture(t);
	const original = new Error('authentication unavailable');
	reg.syncTarget = () => ({ isAuthenticated: async () => { throw original; } });
	await advance(10000);
	assert.equal(errors.length, 1);
	assert.equal(errors[0], original, 'the diagnostic callback receives the underlying failure');
	assert.equal(reg.syncSchedulingPending(), false);
	await advance(9999); assert.equal(errors.length, 1);
	await advance(1); assert.equal(errors.length, 2);
	assert.equal(calls.length, 0);
});


test('a rejection from the native second authentication check releases the headless scheduler', async t => {
	const { reg, calls, advance } = headlessFixture(t);
	const originalTarget = reg.syncTarget;
	let authenticationChecks = 0;
	reg.syncTarget = () => ({
		...originalTarget(),
		isAuthenticated: async () => {
			authenticationChecks++;
			if (authenticationChecks === 2) throw new Error('second authentication check failed');
			return true;
		},
	});
	const rejected = assert.rejects(reg.scheduleSync(0), /second authentication check failed/);
	await advance(0); await rejected;
	assert.equal(calls.length, 0);
	assert.equal(reg.syncSchedulingPending(), false);
	const next = reg.scheduleSync(0);
	await advance(0); await next;
	assert.equal(calls.length, 1, 'a later request must not stall behind the rejected preparation');
});
