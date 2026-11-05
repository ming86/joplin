const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsExtra = require('fs-extra');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const load = require('./loadSource.cjs');
// The shim uses lib's Undici version, which can differ from the CLI workspace's.
const libRequire = require('node:module').createRequire(path.resolve(__dirname, '../../../lib/package.json'));
// Load the real connector helper with the same Undici dependency used by the shim.
const publicNetworkOnly = load('packages/lib/utils/publicNetworkOnly.ts', { 'undici': libRequire('undici') });

/** Loads the real Node transport with mutable application settings and unrelated services isolated. */
function createShim(settings) {
	const shim = {
		isWindows: () => false,
		isMac: () => false,
		isPortable: () => false,
		setNodeSqlite() {},
		setSqliteVec() {},
		setOnnxRuntime() {},
		fetchWithRetry: operation => operation(),
	};
	const { shimInit } = load('packages/lib/shim-init-node.ts', {
		'./shim': shim,
		'./services/ocr/utils/createAccessiblePdf': () => {},
		'./geolocation-node': class {},
		'./locale': { setLocale() {}, defaultLocale: () => 'en', closestSupportedLocale: value => value, _: value => value },
		'./fs-driver-node': class {},
		'./models/Note': {},
		'./models/Resource': { IMAGE_MAX_DIMENSION: 0 },
		'./path-utils': {},
		'fs-extra': fsExtra,
		'./utils/replaceUnsupportedCharacters': value => value,
		'./utils/publicNetworkOnly': publicNetworkOnly,
		'file-type': { fromFile: async () => null },
		'undici': libRequire('undici'),
		'./services/e2ee/crypto': {},
		'./file-api-driver-local': class {},
		'./mime-utils': {},
		'./models/BaseItem': {},
		'relative': () => '',
		'./models/Setting': { default: { value: key => settings[key] } },
		'./vendor/sjcl.js': {},
		'@joplin/utils/time': { Second: 1000 },
		'@joplin/utils/Logger': { create: () => ({ debug() {} }) },
	});
	shimInit();
	return shim;
}

/** Measures simultaneous requests at the server through the current shim dispatcher. */
async function peakConcurrentRequests(shim) {
	let activeRequests = 0;
	let peakRequests = 0;
	const server = http.createServer((_request, response) => {
		activeRequests++;
		peakRequests = Math.max(peakRequests, activeRequests);
		setTimeout(() => {
			activeRequests--;
			response.end('ok');
		}, 80);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;
	try {
		await Promise.all(Array.from({ length: 12 }, async () => {
			const response = await shim.fetch(url);
			assert.equal(await response.text(), 'ok');
		}));
		return peakRequests;
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
}

test('Undici dispatchers follow the current connection limit only in headless mode', async t => {
	for (const scenario of [
		{ isHeadless: true, initialLimit: 2, currentLimit: 10, initialExpectedLimit: 2, expectedLimit: 10 },
		{ isHeadless: false, initialLimit: 10, currentLimit: 20, initialExpectedLimit: 1, expectedLimit: 1 },
	]) {
		await t.test(`headless=${scenario.isHeadless}`, async t => {
			const settings = { isHeadless: scenario.isHeadless, 'sync.maxConcurrentConnections': scenario.initialLimit };
			const shim = createShim(settings);
			const initialAgent = shim.httpAgent('http://localhost');
			t.after(() => initialAgent.close());
			assert.equal(await peakConcurrentRequests(shim), scenario.initialExpectedLimit);
			assert.strictEqual(shim.httpAgent('http://localhost'), initialAgent);

			settings['sync.maxConcurrentConnections'] = scenario.currentLimit;
			assert.equal(await peakConcurrentRequests(shim), scenario.expectedLimit);
			const currentAgent = shim.httpAgent('http://localhost');
			if (scenario.isHeadless) {
				assert.notStrictEqual(currentAgent, initialAgent);
				t.after(() => currentAgent.close());
			} else {
				assert.strictEqual(currentAgent, initialAgent);
			}
			assert.strictEqual(shim.httpAgent('http://localhost'), currentAgent);
		});
	}
});

test('the Node shim preserves an explicit Host for fetch, downloads and uploads on the shared dispatcher', async t => {
	const requests = [];
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		requests.push({ host: request.headers.host, body: Buffer.concat(chunks).toString() });
		response.end('response bytes');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'joplin-shim-host-'));
	t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
	const url = `http://127.0.0.1:${server.address().port}/`;
	const shim = createShim({ isHeadless: true, 'sync.maxConcurrentConnections': 2 });
	const agent = shim.httpAgent(url);
	t.after(() => agent.close());
	const headers = { Host: 'joplin.example.test' };

	assert.equal(await (await shim.fetch(url, { headers })).text(), 'response bytes');
	const destination = path.join(directory, 'download');
	await shim.fetchBlob(url, { headers, path: destination });
	assert.equal(await fs.promises.readFile(destination, 'utf8'), 'response bytes');
	const source = path.join(directory, 'upload');
	await fs.promises.writeFile(source, 'resource bytes');
	assert.equal(await (await shim.uploadBlob(url, { method: 'PUT', headers, path: source })).text(), 'response bytes');
	assert.equal(await (await shim.fetch(url)).text(), 'response bytes');

	assert.deepEqual(requests.map(request => request.host), [headers.Host, headers.Host, headers.Host, new URL(url).host]);
	assert.equal(requests[2].body, 'resource bytes');
	assert.strictEqual(shim.httpAgent(url), agent);
});
