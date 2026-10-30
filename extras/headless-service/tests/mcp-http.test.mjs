import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createAccountRegistry, ServiceError } from '../index.mjs';
import { startMcpHttpServer } from '../src/mcp/http.mjs';
import { account, backend, initialRevisionId, note, noteId, folderId } from './fixtures.mjs';

const token = 'test-http-token';
const version = '2025-11-25';
/** Build a JSON-RPC request without coupling tests to the session implementation. */
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
/** Build a tools/call request using the public tool argument shape. */
const call = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });
/** Expose explicit backend progress so concurrency checks need no timing guesses. */
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
/** Start the real account adapter and HTTP transport with a controllable backend. */
async function start(t, customBackend = backend(), options = {}) {
	const config = account();
	const service = createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id);
	const server = await startMcpHttpServer({ service, bearerToken: token, ...options });
	t.after(() => server.close());
	return server;
}
/** Make one real HTTP request, collecting its status, headers and complete body. */
function exchange(server, message, { method = 'POST', path = '/mcp', headers = {}, raw } = {}) {
	const body = raw ?? (message === undefined ? undefined : JSON.stringify(message));
	return new Promise((resolve, reject) => {
		const req = http.request(`${server.baseUrl}${path}`, {
			method,
			agent: false,
			headers: Object.fromEntries(Object.entries({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'MCP-Protocol-Version': version, ...headers }).filter(([, value]) => value !== undefined)),
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
		req.end(body);
	});
}

test('HTTP MCP initializes without a version header and serves account-bound read-only tools independently', async t => {
	const server = await start(t);
	const init = await exchange(server, request(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } }), { headers: { 'MCP-Protocol-Version': undefined } });
	assert.equal(init.status, 200);
	assert.equal(init.json.result.protocolVersion, version);
	assert.equal(init.headers['mcp-session-id'], undefined);
	const list = await exchange(server, request(2, 'tools/list'));
	assert.equal(list.status, 200);
	assert.ok(list.json.result.tools.length > 0);
	assert.ok(list.json.result.tools.every(tool => tool.annotations.readOnlyHint));
	const read = await exchange(server, call(3, 'read_note', { id: noteId }));
	assert.equal(read.status, 200);
	assert.equal(read.json.result.structuredContent.accountEmail, 'alice@example.test');
	assert.equal(read.json.result.structuredContent.body, 'alice');
	const denied = await exchange(server, call(4, 'create_note', { parentId: folderId, title: 'x' }));
	assert.equal(denied.json.error.code, -32602);
});

test('HTTP MCP enforces bearer credentials, exact origins and POST-only access', async t => {
	const origin = 'https://client.example';
	const server = await start(t, backend(), { allowedOrigins: [origin] });
	for (const authorization of [undefined, 'Bearer wrong-token']) {
		const response = await exchange(server, request(1, 'ping'), { headers: { Authorization: authorization } });
		assert.equal(response.status, 401);
		assert.equal(response.headers['www-authenticate'], 'Bearer');
	}
	assert.equal((await exchange(server, request(1, 'ping'), { headers: { Origin: 'https://other.example' } })).status, 403);
	assert.equal((await exchange(server, request(1, 'ping'), { headers: { Origin: origin } })).status, 200);
	for (const method of ['GET', 'DELETE']) {
		const response = await exchange(server, undefined, { method });
		assert.equal(response.status, 405);
		assert.equal(response.headers.allow, 'POST');
	}
});

test('HTTP MCP accepts notifications and client responses with empty 202 replies', async t => {
	let writes = 0;
	const b = backend();
	b.createNoteWithRevision = async () => { writes++; throw Error('notification executed a tool'); };
	const server = await start(t, b, { allowWrites: true });
	for (const message of [
		{ jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_note', arguments: { title: 'x' } } },
		{ jsonrpc: '2.0', id: 1, result: {} },
	]) {
		const response = await exchange(server, message);
		assert.equal(response.status, 202);
		assert.equal(response.text, '');
	}
	assert.equal(writes, 0);
});

test('HTTP MCP rejects malformed bodies, unsupported media and versions, and accepts large requests', async t => {
	const server = await start(t);
	for (const raw of ['{broken', JSON.stringify([request(1, 'ping')])]) assert.equal((await exchange(server, undefined, { raw })).status, 400);
	assert.equal((await exchange(server, request(1, 'ping'), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
	for (const protocol of [undefined, '2099-01-01']) assert.equal((await exchange(server, request(1, 'tools/list'), { headers: { 'MCP-Protocol-Version': protocol } })).status, 400);
	const largeRequest = request(2, 'ping', { padding: 'x'.repeat(256 * 1024) });
	assert.ok(Buffer.byteLength(JSON.stringify(largeRequest)) > 256 * 1024);
	const largeResponse = await exchange(server, largeRequest);
	assert.equal(largeResponse.status, 200);
	assert.deepEqual(largeResponse.json.result, {});
});

test('HTTP MCP scopes identical ids to each POST and bounds total active dispatches at eight', { timeout: 10000 }, async t => {
	const b = backend();
	const entered = deferred();
	const release = deferred();
	let calls = 0;
	b.getNote = async () => {
		calls++;
		if (calls === 8) entered.resolve();
		await release.promise;
		return { ...note, body: 'independent' };
	};
	const server = await start(t, b);
	t.after(() => release.resolve());
	const active = Array.from({ length: 8 }, () => exchange(server, call('same-id', 'read_note', { id: noteId })));
	await entered.promise;
	const excess = await exchange(server, call('ninth', 'read_note', { id: noteId }));
	assert.equal(excess.status, 503);
	assert.equal(calls, 8);
	release.resolve();
	for (const response of await Promise.all(active)) {
		assert.equal(response.status, 200);
		assert.equal(response.json.id, 'same-id');
		assert.equal(response.json.result.structuredContent.body, 'independent');
	}
	assert.equal((await exchange(server, call('next', 'read_note', { id: noteId }))).status, 200);
});

test('HTTP readiness checks backend availability while liveness remains healthy', async t => {
	const b = backend();
	b.listNoteSummaries = async () => { throw Error('private backend failure'); };
	const server = await start(t, b);
	const live = await exchange(server, undefined, { method: 'GET', path: '/healthz' });
	assert.equal(live.status, 200);
	const ready = await exchange(server, undefined, { method: 'GET', path: '/readyz' });
	assert.equal(ready.status, 503);
	assert.deepEqual(ready.json, { ready: false });
});

test('HTTP shutdown aborts the dispatched account operation', { timeout: 10000 }, async t => {
	const b = backend();
	const entered = deferred();
	let signal;
	b.getNote = async (_id, operationSignal) => {
		signal = operationSignal;
		entered.resolve();
		await new Promise(resolve => operationSignal.addEventListener('abort', resolve, { once: true }));
		throw new ServiceError('request_cancelled');
	};
	const server = await start(t, b);
	const pending = exchange(server, call(1, 'read_note', { id: noteId }));
	await entered.promise;
	await server.close();
	assert.equal(signal.aborted, true);
	assert.equal((await pending).json.result.structuredContent.error.code, 'request_cancelled');
});

test('HTTP client disconnection leaves dispatched write work running', { timeout: 10000 }, async t => {
	const b = backend();
	const entered = deferred();
	const release = deferred();
	const completed = deferred();
	let signal;
	let writes = 0;
	b.createNoteWithRevision = async (input, operationSignal) => {
		signal = operationSignal;
		writes++;
		entered.resolve();
		await release.promise;
		completed.resolve();
		return { ...note, title: input.title, notebook_id: input.notebook_id ?? input.parentId, body: input.body ?? '', updated_time: 101, revision_id: '2'.repeat(32) };
	};
	const server = await start(t, b, { allowWrites: true });
	t.after(() => release.resolve());
	const req = http.request(`${server.baseUrl}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'MCP-Protocol-Version': version } });
	req.on('error', () => {});
	req.end(JSON.stringify(call(1, 'create_note', { parentId: folderId, title: 'saved after disconnect' })));
	await entered.promise;
	const disconnected = new Promise(resolve => req.once('close', resolve));
	req.destroy();
	await disconnected;
	assert.equal(signal.aborted, false);
	release.resolve();
	await completed.promise;
	assert.equal(writes, 1);
	assert.equal(signal.aborted, false);
});

test('HTTP keeps a small edit to a large note response compact', async t => {
	const b = backend();
	const body = `${'x'.repeat(2 * 1024 * 1024)}needle`;
	const savedBody = `${'x'.repeat(2 * 1024 * 1024)}updated`;
	const largeNote = { ...note, body };
	let writes = 0;
	b.getNote = async () => ({ ...largeNote });
	b.updateNote = async (_id, patch) => { writes++; return { ...largeNote, ...patch, body: savedBody }; };
	const server = await start(t, b, { allowWrites: true });
	const response = await exchange(server, call(1, 'update_note', { id: noteId, base_revision_id: initialRevisionId, replace_text: { find: 'needle', replace: 'updated' } }));
	assert.equal(response.status, 200);
	assert.equal(response.json.result.isError, false);
	const result = response.json.result.structuredContent;
	assert.deepEqual(Object.keys(result).sort(), ['body_length', 'body_sha256', 'body_size_bytes', 'body_total_line_count', 'changed', 'id', 'previous_revision_id', 'revision_id', 'updated_time']);
	assert.equal(result.body_length, savedBody.length);
	assert.equal(result.body_size_bytes, Buffer.byteLength(savedBody));
	assert.equal(result.body_sha256, createHash('sha256').update(savedBody, 'utf8').digest('hex'));
	assert.equal(result.body_total_line_count, 1);
	assert.ok(Buffer.byteLength(response.text) < 10_000, 'the reply does not echo the large updated note body');
	assert.equal(writes, 1);
});
