import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRegistry } from '../index.mjs';
import { createMcpSession } from '../mcp.mjs';
import { account, backend } from './fixtures.mjs';

const protocolVersionKey = 'io.modelcontextprotocol/protocolVersion';
const clientCapabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
const serverInfoKey = 'io.modelcontextprotocol/serverInfo';
const modernVersions = ['2026-07-28', '2025-11-25', '2025-06-18'];

const modernMeta = (version = '2026-07-28') => ({
	[protocolVersionKey]: version,
	[clientCapabilitiesKey]: {},
});

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const modernRequest = (id, method, params = {}, meta = modernMeta()) => request(id, method, { ...params, _meta: meta });
const legacyInitialize = version => request(1, 'initialize', {
	protocolVersion: version,
	capabilities: {},
	clientInfo: { name: 'test-client', version: '1' },
});

function createSession({ allowWrites = false, config = account(), customBackend = backend() } = {}) {
	const service = createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id);
	return createMcpSession(service, { allowWrites });
}

function assertServerInfo(result) {
	const info = result._meta?.[serverInfoKey];
	assert.equal(typeof info?.name, 'string');
	assert.ok(info.name.length > 0);
	assert.equal(typeof info.version, 'string');
	assert.ok(info.version.length > 0);
}

function assertCacheHints(result) {
	assert.ok(Number.isInteger(result.ttlMs));
	assert.ok(result.ttlMs >= 0);
	assert.ok(['public', 'private'].includes(result.cacheScope));
}

test('modern discovery works before initialization and advertises the implemented capabilities', async t => {
	const session = createSession();
	t.after(() => session.close());

	const response = await session.handle(modernRequest(1, 'server/discover'));
	assert.equal(response.id, 1);
	assert.equal(response.result.resultType, 'complete');
	assert.deepEqual(new Set(response.result.supportedVersions), new Set(modernVersions));
	assert.deepEqual(response.result.capabilities, { tools: {}, resources: {} });
	assertCacheHints(response.result);
	assertServerInfo(response.result);
});

test('modern tools/list and tools/call use complete results, cache hints, and server identity', async t => {
	const session = createSession();
	t.after(() => session.close());

	const listed = await session.handle(modernRequest(1, 'tools/list'));
	assert.equal(listed.result.resultType, 'complete');
	assert.ok(Array.isArray(listed.result.tools));
	assert.ok(listed.result.tools.some(tool => tool.name === 'get_status'));
	assertCacheHints(listed.result);
	assertServerInfo(listed.result);

	const called = await session.handle(modernRequest(2, 'tools/call', {
		name: 'get_status',
		arguments: {},
	}));
	assert.equal(called.result.resultType, 'complete');
	assert.ok(Array.isArray(called.result.content));
	assert.notEqual(called.result.isError, true);
	assertServerInfo(called.result);
});

test('modern required metadata and unsupported protocol versions have distinct errors', async t => {
	const session = createSession();
	t.after(() => session.close());

	const missingMetadata = await session.handle(request(1, 'server/discover'));
	assert.equal(missingMetadata.error.code, -32602);

	const missingCapabilities = await session.handle(modernRequest(2, 'server/discover', {}, {
		[protocolVersionKey]: '2026-07-28',
	}));
	assert.equal(missingCapabilities.error.code, -32602);

	const malformedMetadata = await session.handle(modernRequest(3, 'server/discover', {}, {
		[protocolVersionKey]: '2026-07-28',
		[clientCapabilitiesKey]: [],
	}));
	assert.equal(malformedMetadata.error.code, -32602);

	const malformedVersion = await session.handle(modernRequest(4, 'server/discover', {}, {
		[protocolVersionKey]: 2026,
		[clientCapabilitiesKey]: {},
	}));
	assert.equal(malformedVersion.error.code, -32602);

	const unsupportedVersion = await session.handle(modernRequest(5, 'server/discover', {}, modernMeta('1900-01-01')));
	assert.equal(unsupportedVersion.error.code, -32022);
	assert.equal(unsupportedVersion.error.data.requested, '1900-01-01');
	assert.deepEqual(new Set(unsupportedVersion.error.data.supported), new Set(modernVersions));

	// A metadata-free ordinary request still follows the legacy initialization guard.
	assert.equal((await session.handle(request(6, 'tools/list'))).error.code, -32000);
});

test('modern ping and initialize are absent while the legacy initialize handshake remains available', async t => {
	const session = createSession();
	t.after(() => session.close());

	for (const method of ['ping', 'initialize']) {
		const response = await session.handle(modernRequest(1, method));
		assert.equal(response.error.code, -32601);
	}

	const initialized = await session.handle(legacyInitialize('2025-11-25'));
	assert.equal(initialized.result.protocolVersion, '2025-11-25');
	await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
	const listed = await session.handle(request(2, 'tools/list'));
	assert.ok(Array.isArray(listed.result.tools));
	assert.equal('resultType' in listed.result, false);
	assert.equal('ttlMs' in listed.result, false);
});

test('modern write tool call remains blocked by read-only account permission', async t => {
	const config = account();
	config.permissions = ['read'];
	const customBackend = backend();
	let writeCalls = 0;
	customBackend.createNote = async () => { writeCalls++; throw new Error('write should not reach backend'); };
	const session = createSession({ allowWrites: true, config, customBackend });
	t.after(() => session.close());

	const response = await session.handle(modernRequest(1, 'tools/call', {
		name: 'create_note',
		arguments: { parentId: 'b'.repeat(32), title: 'test', body: 'body' },
	}));
	assert.equal(response.result.resultType, 'complete');
	assert.equal(response.result.isError, true);
	assert.ok(Array.isArray(response.result.content));
	assert.equal(writeCalls, 0);
});
