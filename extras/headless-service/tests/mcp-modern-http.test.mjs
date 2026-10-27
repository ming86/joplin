import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAccountRegistry } from '../index.mjs';
import { startMcpHttpServer } from '../src/mcp/http.mjs';
import { account, backend, initialRevisionId, note, noteId, folderId } from './fixtures.mjs';

const version = '2026-07-28';
const versionKey = 'io.modelcontextprotocol/protocolVersion';
const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
const serverInfoKey = 'io.modelcontextprotocol/serverInfo';
const token = 'modern-http-test-token';

/** Build a modern request with all mandatory per-request metadata. */
function request(id, method, params = {}) {
	return { jsonrpc: '2.0', id, method, params: { _meta: { [versionKey]: version, [capabilitiesKey]: {} }, ...params } };
}
/** Build a tool call using its public argument shape. */
const call = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });

/** Bind the transport to the real account service backed by fixture operations. */
async function start(t, customBackend = backend(), allowWrites = false) {
	const config = account();
	const service = createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id);
	const server = await startMcpHttpServer({ service, bearerToken: token, allowWrites });
	t.after(() => server.close());
	return server;
}

/** Send a real POST with body-derived routing headers; undefined overrides omit a header. */
function exchange(server, message, overrides = {}) {
	const headers = {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		'MCP-Protocol-Version': version,
		'Mcp-Method': message.method,
		...(message.method === 'tools/call' ? { 'Mcp-Name': message.params.name } : {}),
		...overrides,
	};
	return new Promise((resolve, reject) => {
		const req = http.request(`${server.baseUrl}/mcp`, {
			method: 'POST', agent: false,
			headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
		}, res => {
			const parts = [];
			res.on('data', part => parts.push(part));
			res.on('error', reject);
			res.on('end', () => {
				const text = Buffer.concat(parts).toString();
				resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : undefined });
			});
		});
		req.on('error', reject);
		req.end(JSON.stringify(message));
	});
}

/** Check modern completion and server identity without fixing a product version string. */
function assertComplete(response) {
	assert.equal(response.status, 200);
	assert.equal(response.json.result.resultType, 'complete');
	const info = response.json.result._meta[serverInfoKey];
	assert.equal(info.name, 'joplin-headless');
	assert.equal(info.version, '0.2.0');
	assert.equal(info.title, 'Joplin MCP');
	assert.equal(info.icons[0].mimeType, 'image/png');
	assert.deepEqual(info.icons[0].sizes, ['256x256']);
	assert.ok(info.icons[0].src.startsWith('data:image/png;base64,'));
}

/** Check an HTTP/JSON-RPC error pair and preserve the incoming request id. */
function assertError(response, status, code, id) {
	assert.equal(response.status, status);
	assert.equal(response.json.error.code, code);
	assert.equal(response.json.id, id);
	assert.equal(response.json.result, undefined);
}

test('modern HTTP discovers, lists, reads and saves through the account service without initialization', async t => {
	const b = backend();
	const create = b.createNote;
	let writes = 0;
	b.createNote = async (input, signal) => { writes++; return create(input, signal); };
	const server = await start(t, b, true);
	const discover = await exchange(server, request(1, 'server/discover'));
	assertComplete(discover);
	assert.ok(discover.json.result.supportedVersions.includes(version));
	assert.deepEqual(discover.json.result.capabilities, { tools: {}, resources: {} });
	const listed = await exchange(server, request(2, 'tools/list'));
	assertComplete(listed);
	assert.ok(listed.json.result.tools.some(tool => tool.name === 'create_note'));
	for (const response of [discover, listed]) {
		assert.equal(response.json.result.ttlMs, 0);
		assert.equal(response.json.result.cacheScope, 'private');
		assert.equal(response.headers['cache-control'], 'no-store');
		assert.equal(response.headers['mcp-session-id'], undefined);
	}
	const read = await exchange(server, call(3, 'read_note', { id: noteId }));
	assertComplete(read);
	assert.equal(read.json.result.structuredContent.accountEmail, 'alice@example.test');
	assert.equal(read.json.result.structuredContent.body, 'alice');
	const saved = await exchange(server, call(4, 'create_note', { parentId: folderId, title: 'Modern HTTP', body: 'Saved once' }));
	assertComplete(saved);
	assert.equal(saved.json.result.isError, false);
	assert.deepEqual(Object.keys(saved.json.result.structuredContent).sort(), ['id', 'notebook_id', 'title']);
	assert.equal(saved.json.result.structuredContent.title, 'Modern HTTP');
	assert.equal(writes, 1);
	const encodedName = await exchange(server, call(5, 'get_status'), { 'Mcp-Name': '=?base64?Z2V0X3N0YXR1cw==?=' });
	assertComplete(encodedName);
	assert.equal(encodedName.json.result.structuredContent.accountId, 'alice');
	assertError(await exchange(server, call(6, 'get_status'), { 'Mcp-Name': '=?base64?%%%?=' }), 400, -32020, 6);
});

test('modern HTTP rejects absent or mismatched routing headers before dispatching writes', async t => {
	const b = backend();
	let writes = 0;
	b.createNote = async () => { writes++; return { ...note }; };
	const server = await start(t, b, true);
	const message = call('write', 'create_note', { parentId: folderId, title: 'Blocked' });
	for (const headers of [
		{ 'MCP-Protocol-Version': undefined },
		{ 'MCP-Protocol-Version': '2025-11-25' },
		{ 'Mcp-Method': undefined },
		{ 'Mcp-Method': 'tools/list' },
		{ 'Mcp-Name': undefined },
		{ 'Mcp-Name': 'delete_note' },
	]) assertError(await exchange(server, message, headers), 400, -32020, 'write');
	assert.equal(writes, 0);
});

test('modern HTTP requires version and capabilities in every request body', async t => {
	const server = await start(t);
	for (const params of [
		{},
		{ _meta: { [versionKey]: version } },
		{ _meta: { [capabilitiesKey]: {} } },
	]) assertError(await exchange(server, { jsonrpc: '2.0', id: 1, method: 'server/discover', params }), 400, -32602, 1);
});

test('modern HTTP reports unsupported versions and unknown methods with their specified statuses', async t => {
	const server = await start(t);
	const unsupported = request(1, 'server/discover', { _meta: { [versionKey]: '2099-01-01', [capabilitiesKey]: {} } });
	for (const headerVersion of ['2099-01-01', '2025-11-25']) {
		const response = await exchange(server, unsupported, { 'MCP-Protocol-Version': headerVersion });
		assertError(response, 400, -32022, 1);
		assert.equal(response.json.error.data.requested, '2099-01-01');
		assert.ok(response.json.error.data.supported.includes(version));
	}
	assertError(await exchange(server, request(2, 'unknown/method')), 404, -32601, 2);
	// The resource route is implemented; unknown opaque URIs receive a safe resource error.
	const unavailable = await exchange(server, request(3, 'resources/read', { uri: 'note://example/readable' }), { 'Mcp-Name': 'note://example/readable' });
	assertError(unavailable, 200, -32002, 3);
	assert.equal(JSON.stringify(unavailable.json).includes('note://example/readable'), false);
	// Routing headers remain valid for standard methods outside this server's catalog.
	for (const [method, params, nameHeader] of [
		['prompts/get', { name: 'summarize' }, 'summarize'],
		['prompts/get', { name: '笔记' }, `=?base64?${Buffer.from('笔记').toString('base64')}?=`],
	]) {
		const message = request(4, method, params);
		assertError(await exchange(server, message, { 'Mcp-Name': nameHeader }), 404, -32601, 4);
		assertError(await exchange(server, message, { 'Mcp-Name': 'different-name' }), 400, -32020, 4);
	}
});

test('modern HTTP rejects notification and client-response POSTs while legacy keeps empty 202 replies', async t => {
	const server = await start(t);
	for (const message of [
		{ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
		{ jsonrpc: '2.0', id: 1, result: {} },
	]) {
		assert.equal((await exchange(server, message)).status, 400);
		const legacy = await exchange(server, message, { 'MCP-Protocol-Version': '2025-11-25' });
		assert.equal(legacy.status, 202);
		assert.equal(legacy.text, '');
	}
});

test('modern HTTP keeps a small edit to a large note response compact', async t => {
	const b = backend();
	const body = `${'x'.repeat(2 * 1024 * 1024)}needle`;
	const largeNote = { ...note, body };
	let writes = 0;
	b.getNote = async () => ({ ...largeNote });
	b.updateNote = async (_id, patch) => { writes++; return { ...largeNote, ...patch }; };
	const server = await start(t, b, true);
	const response = await exchange(server, call(1, 'update_note', { id: noteId, base_revision_id: initialRevisionId, replace_text: { find: 'needle', replace: 'updated' } }));
	assertComplete(response);
	assert.equal(response.json.result.isError, false);
	assert.deepEqual(Object.keys(response.json.result.structuredContent).sort(), ['changed', 'id', 'previous_revision_id', 'revision_id', 'updated_time']);
	// The modern server identity, including its embedded icon, is returned in _meta; measure the tool reply without that metadata.
	const responseWithoutServerMetadata = { ...response.json, result: { ...response.json.result } };
	delete responseWithoutServerMetadata.result._meta;
	assert.ok(Buffer.byteLength(JSON.stringify(responseWithoutServerMetadata)) < 10_000, 'the tool reply does not echo the large updated note body');
	assert.equal(writes, 1);
});
