const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const load = require('./loadSource.cjs');

function createShim(settings) {
	const shim = {
		isWindows: () => false,
		isMac: () => false,
		isPortable: () => false,
		setNodeSqlite() {},
		setSqliteVec() {},
		setOnnxRuntime() {},
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
		'fs-extra': fs,
		'./utils/replaceUnsupportedCharacters': value => value,
		'file-type': { fromFile: async () => null },
		'./services/e2ee/crypto': {},
		'./file-api-driver-local': class {},
		'./mime-utils': {},
		'./models/BaseItem': {},
		'hpagent': { HttpProxyAgent: class {}, HttpsProxyAgent: class {} },
		'relative': () => '',
		'./models/Setting': { default: { value: key => settings[key] } },
		'form-data': class {},
		'./vendor/sjcl.js': {},
		'node-fetch': () => {},
	});
	shimInit();
	return shim;
}

async function peakConcurrentRequests(agent) {
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
		await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
			const request = http.get(url, { agent }, response => {
				response.resume();
				response.on('end', resolve);
			});
			request.on('error', reject);
		})));
		return peakRequests;
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
}

test('HTTP agents follow the current connection limit only in headless mode', async t => {
	for (const scenario of [
		{ isHeadless: true, initialLimit: 2, currentLimit: 10, expectedLimit: 10 },
		{ isHeadless: false, initialLimit: 10, currentLimit: 20, expectedLimit: 1 },
	]) {
		const settings = { isHeadless: scenario.isHeadless, 'sync.maxConcurrentConnections': scenario.initialLimit };
		const shim = createShim(settings);
		const initialAgents = shim.httpAgents();
		settings['sync.maxConcurrentConnections'] = scenario.currentLimit;
		const agents = shim.httpAgents();
		t.after(() => {
			agents.http.destroy();
			agents.https.destroy();
		});

		assert.strictEqual(agents, initialAgents);
		assert.equal(agents.http.maxSockets, scenario.expectedLimit);
		assert.equal(agents.https.maxSockets, scenario.expectedLimit);
		assert.equal(await peakConcurrentRequests(agents.http), scenario.expectedLimit);
	}
});
