const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const load = require('./loadSource.cjs');

const canonicalHost = 'joplin.example.test';
const logger = { create: () => ({ warn() {}, error() {}, info() {} }) };

function serverApi(shim) {
	return load('packages/lib/JoplinServerApi.ts', {
		'./shim': shim,
		'./locale': {},
		'./path-utils': { rtrimSlashes: value => value.replace(/\/+$/, '') },
		'./JoplinError': class extends Error {},
		'./models/Setting': { Env: { Dev: 'dev' } },
		'@joplin/utils/Logger': logger,
		'./services/joplinServer/personalizedUserContentBaseUrl': {},
		'./net-utils': {},
		'./services/joplinCloudUtils': { getApplicationInformation: async () => ({ platform: 'linux', type: 'cli' }) },
		'query-string': {},
	}).default;
}

function syncTarget(Api, settings) {
	return load('packages/lib/SyncTargetJoplinServer.ts', {
		'./file-api-driver-joplinServer': class { constructor(api) { this.api = api; } },
		'./models/Setting': { value: key => settings[key] },
		'./Synchronizer': {},
		'./locale': {},
		'./JoplinServerApi': Api,
		'./BaseSyncTarget': class {},
		'./file-api': { FileApi: class {
			constructor(_path, driver) { this.driver = driver; }
			setSyncTargetId() {}
			async initialize() {}
		} },
		'@joplin/utils/Logger': logger,
	});
}

test('headless private sync sends the canonical Host to the private URL for authentication, string requests and file transfers', async t => {
	const requests = [];
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		requests.push({ path: request.url, host: request.headers.host, auth: request.headers['x-api-auth'], body: Buffer.concat(chunks).toString() });
		response.setHeader('Content-Type', 'application/json');
		response.end(request.url === '/api/sessions' ? JSON.stringify({ id: 'session', user_id: 'user' }) : JSON.stringify({ ok: true }));
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	const privateUrl = `http://127.0.0.1:${server.address().port}`;
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'joplin-private-sync-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const source = path.join(directory, 'source');
	const destination = path.join(directory, 'destination');
	await fs.writeFile(source, 'resource bytes');
	const transports = [];

	// Keep the real API and target wiring; replace platform adapters with local HTTP/file I/O.
	const request = (url, options) => new Promise((resolve, reject) => {
		assert.ok(url.startsWith(`${privateUrl}/`));
		const outgoing = http.request(url, { method: options.method, headers: options.headers }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({ ok: response.statusCode < 400, status: response.statusCode, text: async () => Buffer.concat(chunks).toString() }));
		});
		outgoing.on('error', reject);
		outgoing.end(options.body);
	});
	const Api = serverApi({
		appVersion: () => 'test',
		stringByteLength: value => Buffer.byteLength(value),
		fsDriver: () => ({ stat: filename => fs.stat(filename) }),
		fetch: (url, options) => { transports.push('string'); return request(url, options); },
		uploadBlob: async (url, options) => { transports.push('upload'); return request(url, { ...options, body: await fs.readFile(options.path) }); },
		fetchBlob: async (url, options) => {
			transports.push('download');
			const response = await request(url, options);
			await fs.writeFile(options.path, await response.text());
			return response;
		},
	});
	const { newFileApi } = syncTarget(Api, { isHeadless: true, 'sync.9.headlessHost': canonicalHost });
	const fileApi = await newFileApi(9, {
		path: () => privateUrl, userContentPath: () => '', username: () => 'test@example.test', password: () => 'test-password', apiKey: () => '',
	});
	const api = fileApi.driver.api;
	await api.exec('PUT', 'api/items/text', null, 'note text');
	await api.exec('PUT', 'api/items/upload', null, null, null, { source: 'file', path: source });
	await api.exec('GET', 'api/items/download', null, null, null, { target: 'file', path: destination, responseFormat: 'text' });
	assert.deepEqual(transports, ['string', 'string', 'upload', 'download']);
	assert.deepEqual(requests.map(value => value.path), ['/api/sessions', '/api/items/text', '/api/items/upload', '/api/items/download']);
	assert.ok(requests.every(value => value.host === canonicalHost));
	assert.equal(requests[0].auth, undefined);
	assert.ok(requests.slice(1).every(value => value.auth === 'session'));
	assert.equal(requests[2].body, 'resource bytes');
	assert.equal(await fs.readFile(destination, 'utf8'), '{"ok":true}');
});

test('the Host setting applies only to headless Joplin Server, including its sharing API', async () => {
	class Api { constructor(options) { this.options = options; } }
	for (const [isHeadless, target, expected] of [[true, 9, canonicalHost], [false, 9, ''], [true, 10, ''], [true, 11, '']]) {
		const settings = { isHeadless, 'sync.target': target, 'sync.9.headlessHost': canonicalHost };
		const { newFileApi } = syncTarget(Api, settings);
		const fileApi = await newFileApi(target, {});
		assert.equal(fileApi.driver.api.options.hostHeader(), expected);

		const mocks = Object.fromEntries([
			'../../BaseModel', '../../locale', '../../models/Folder', '../../models/MasterKey', '../../models/Note',
			'../e2ee/EncryptionService', '../e2ee/ppk/ppk', '../e2ee/utils', '../ResourceService', '../synchronizer/syncInfoUtils', './reducer',
		].map(name => [name, {}]));
		Object.assign(mocks, {
			'../../JoplinServerApi': Api,
			'../../models/Setting': { value: key => settings[key] },
			'@joplin/utils/Logger': logger,
			'../../PerformanceLogger': { create: () => ({}) },
		});
		const ShareService = load('packages/lib/services/share/ShareService.ts', mocks).default;
		assert.equal(new ShareService().api().options.hostHeader(), expected);
	}
});

test('API requests without a Host option preserve the transport default', async () => {
	let headers;
	const Api = serverApi({ fetch: async (_url, options) => {
		headers = options.headers;
		return { ok: true, text: async () => '{}' };
	} });
	const api = new Api({ baseUrl: () => 'http://private-server:22300', session: () => ({ id: 'session' }) });
	await api.exec('GET', 'api/ping');
	assert.equal(Object.hasOwn(headers, 'Host'), false);
});
