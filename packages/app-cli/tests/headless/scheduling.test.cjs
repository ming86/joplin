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
function headlessFixture(t) {
	let now = 0;
	const originalNow = Date.now;
	Date.now = () => now;
	t.after(() => { Date.now = originalNow; });
	const timers = new Set();
	const shim = {
		isElectron: () => false,
		setTimeout(fn, ms) { const timer = { fn, due: now + ms }; timers.add(timer); return timer; },
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
	output.reg.setSyncSchedulingPolicy((run, pendingChanged) => new Scheduler(run, pendingChanged, 10000, () => errors.push(true)));
	output.reg.setupRecurrentSync();
	t.after(() => output.reg.setSyncSchedulingPolicy(null));
	return {
		...output, timers, errors,
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

test('headless registry keeps its 10-second inbound clock despite repeated local saves', async t => {
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
	assert.equal([...timers].filter(timer => timer.interval === 10000).length, 1);
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

test('periodic ticks and synchronizer followups never overlap or downgrade a pending full sync', async t => {
	const { reg, fakeSync, calls, advance } = headlessFixture(t);
	const running = deferred();
	fakeSync.start = async options => { calls.push(options); await running.promise; return {}; };
	const startup = reg.scheduleSync(0);
	await advance(0);
	await advance(30000);
	void reg.scheduleSync(1000, partialOptions);
	assert.equal(calls.length, 1);
	running.resolve(); await startup; await turn();
	await advance(0);
	assert.equal(calls.length, 2, 'three ticks coalesce into one follow-up');
	assert.equal(calls[1].syncSteps, undefined);
	assert.equal(calls[1].remoteChangesOnly, undefined, 'a local upload combined with a poll becomes an ordinary full sync');
});

test('headless remote polls stay fixed while the full-sync delay starts after completion', async t => {
	const { reg, calls, advance, timers } = headlessFixture(t);
	const startup = reg.scheduleSync(0);
	await advance(0); await startup;
	assert.deepEqual([...timers].filter(timer => timer.interval).map(timer => timer.interval), [10000]);
	assert.equal([...timers].find(timer => !timer.interval).due, 120000);

	await advance(10000);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].remoteChangesOnly, true);
	await advance(109999);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 1, 'polls do not restart or replace the full-sync clock');
	await advance(1);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 2, 'the ordinary full sync still runs at 120 seconds');
	assert.equal(calls[calls.length - 1].remoteChangesOnly, undefined);
	assert.equal([...timers].find(timer => !timer.interval).due, 240000, 'the next delay begins when that full sync settles');
});

test('a slow periodic full sync delays the next full sync until 120 seconds after completion', async t => {
	const { reg, fakeSync, calls, advance } = headlessFixture(t);
	const startup = reg.scheduleSync(0);
	await advance(0); await startup;
	const periodicFull = deferred();
	let fullRuns = 0;
	fakeSync.start = async options => {
		calls.push(options);
		if (!options.remoteChangesOnly && ++fullRuns === 1) await periodicFull.promise;
		return {};
	};

	await advance(120000);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 2, 'the first periodic full sync starts after its delay');
	await advance(120000);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 2, 'a full sync still running at its next fixed-clock deadline does not queue another full sync');

	periodicFull.resolve();
	await advance(0);
	await advance(119999);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 2, 'the next delay starts after the slow full sync finishes');
	await advance(1);
	assert.equal(calls.filter(options => !options.remoteChangesOnly).length, 3, 'the next full sync starts 120 seconds after completion');
});

test('a remote poll and a queued local upload merge into an ordinary full sync', async t => {
	const { reg, calls, advance } = headlessFixture(t);
	const startup = reg.scheduleSync(0);
	await advance(0); await startup;
	await advance(9000);
	const upload = reg.scheduleSync(5000, partialOptions);
	await advance(1000);
	await upload;
	assert.equal(calls.length, 2);
	assert.equal(calls[1].syncSteps, undefined);
	assert.equal(calls[1].remoteChangesOnly, undefined);
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
	reg.syncTarget = () => ({ isAuthenticated: async () => { throw new Error('authentication unavailable'); } });
	await advance(10000);
	assert.equal(errors.length, 1);
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
