const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
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
		'./shim': shim, './SyncTargetRegistry': {},
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
