const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const load = require('./loadSource.cjs');

function clipper({ headless = true, port = 0, route = async () => ({ ok: true }) } = {}) {
	const states = [];
	class Logger {
		info() {}
		warn() {}
		error() {}
	}
	class Api {
		async route(...args) { return route(...args); }
	}
	const { default: Clipper, StartState } = load('packages/lib/ClipperServer.ts', {
		'./models/Setting': { value: key => ({ 'isHeadless': headless, 'api.port': port, 'api.token': 'private-test-token' })[key] },
		'@joplin/utils/Logger': Logger,
		'./services/rest/Api': Api,
		'./services/rest/ApiResponse': class {},
		'./path-utils': { ltrimSlashes: s => s.replace(/^\/+/, '') },
		'./randomClipperPort': {},
		'server-destroy': server => { server.destroy = () => { server.closeAllConnections(); server.close(() => {}); }; },
		'multiparty': {},
	});
	const server = new Clipper();
	server.setDispatch(action => states.push(action));
	server.initialize();
	server.findAvailablePort = async () => 0;
	return { server, states, StartState, url: () => `http://127.0.0.1:${server.server_.address().port}` };
}

test('private API start resolves only after real loopback listening', async t => {
	const fixture = clipper();
	t.after(() => fixture.server.stop());
	await fixture.server.start({ returnWhenListening: true });
	assert.equal(fixture.server.server_.address().address, '127.0.0.1');
	assert.equal(fixture.states.filter(s => s.type === 'CLIPPER_SERVER_SET' && s.startState).at(-1).startState, fixture.StartState.Started);
	const response = await fetch(`${fixture.url()}/ping`);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
});

test('port conflict rejects startup rather than falsely reporting ready', async t => {
	const occupied = http.createServer();
	await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => occupied.close(resolve)));
	const fixture = clipper({ port: occupied.address().port });
	t.after(() => fixture.server.stop());
	await assert.rejects(fixture.server.start({ returnWhenListening: true }), { code: 'EADDRINUSE' });
	assert.ok(!fixture.states.some(s => s.startState === fixture.StartState.Started));
});

test('headless pairing routes are disabled, including normalized aliases', async t => {
	let routed = 0;
	const fixture = clipper({ route: async () => { routed++; return {}; } });
	t.after(() => fixture.server.stop());
	await fixture.server.start({ returnWhenListening: true });
	for (const path of ['/auth', '/auth/check', '//auth']) {
		const response = await fetch(`${fixture.url()}${path}`, { method: 'POST' });
		assert.equal(response.status, 403);
		assert.ok(!(await response.text()).includes('private-test-token'));
	}
	assert.equal(routed, 0);
});

test('ordinary CLI pairing behavior remains available to native clients', async t => {
	let routed = 0;
	const fixture = clipper({ headless: false, route: async () => { routed++; return { pending: true }; } });
	t.after(() => fixture.server.stop());
	await fixture.server.start({ returnWhenListening: true });
	const response = await fetch(`${fixture.url()}/auth`, { method: 'POST' });
	assert.equal(response.status, 200);
	await response.text();
	assert.equal(routed, 1);
});

test('graceful stop drains an in-flight request before resolving', async t => {
	let release;
	let entered;
	const waiting = new Promise(resolve => { release = resolve; });
	const handling = new Promise(resolve => { entered = resolve; });
	const fixture = clipper({ route: async () => { entered(); await waiting; return { saved: true }; } });
	t.after(() => fixture.server.stop());
	await fixture.server.start({ returnWhenListening: true });
	const request = fetch(`${fixture.url()}/notes`);
	await handling;
	let stopped = false;
	const stopping = fixture.server.stop({ graceful: true }).then(() => { stopped = true; });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(stopped, false);
	release();
	assert.deepEqual(await (await request).json(), { saved: true });
	await stopping;
	assert.equal(stopped, true);
});
