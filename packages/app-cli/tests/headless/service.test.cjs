const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const load = require('./loadSource.cjs');
const { runService } = load('packages/app-cli/app/headless/runService.ts');
const turn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
}

test('ready follows completed startup; repeated signals trigger one drain and clean listeners', async () => {
	const events = new EventEmitter();
	const started = deferred();
	const draining = deferred();
	const calls = [];
	const service = runService({
		start: () => started.promise,
		ready: () => calls.push('ready'),
		stop: async () => { calls.push('drain'); await draining.promise; calls.push('closed'); },
		timedOut: () => assert.fail('unexpected timeout'),
	}, events);
	await turn();
	assert.deepEqual(calls, []);
	started.resolve();
	await turn();
	assert.deepEqual(calls, ['ready']);
	events.emit('SIGTERM');
	events.emit('SIGINT');
	await turn();
	assert.deepEqual(calls, ['ready', 'drain']);
	draining.resolve();
	await service;
	assert.deepEqual(calls, ['ready', 'drain', 'closed']);
	assert.equal(events.listenerCount('SIGINT'), 0);
	assert.equal(events.listenerCount('SIGTERM'), 0);
});

test('signal during startup prevents false ready and still stops initialized work', async () => {
	const events = new EventEmitter();
	const starting = deferred();
	let stops = 0;
	const service = runService({
		start: () => starting.promise,
		stop: async () => { stops++; },
		ready: () => assert.fail('must not become ready after stop request'),
		timedOut: () => assert.fail('unexpected timeout'),
	}, events);
	events.emit('SIGTERM');
	starting.resolve();
	await service;
	assert.equal(stops, 1);
});

test('start failure triggers cleanup, not a success signal', async () => {
	let stopped = false;
	await assert.rejects(runService({
		start: async () => { throw new Error('bind failed'); },
		stop: async () => { stopped = true; },
		ready: () => assert.fail('not ready'),
		timedOut: () => assert.fail('unexpected timeout'),
	}, new EventEmitter()), /bind failed/);
	assert.equal(stopped, true);
});

test('shutdown has a deadline, rather than silently abandoning live work', async () => {
	const events = new EventEmitter();
	const draining = deferred();
	let timedOut = false;
	const service = runService({
		start: async () => {},
		ready: () => events.emit('SIGTERM'),
		stop: () => draining.promise,
		timedOut: () => { timedOut = true; draining.resolve(); },
	}, events, 10);
	await service;
	assert.equal(timedOut, true);
});
