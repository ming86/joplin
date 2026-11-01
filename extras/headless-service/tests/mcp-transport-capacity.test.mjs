import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstLine, startMcpSocket, connectPrivateSocket } from '../src/fleet/socket.mjs';
import { modernProtocolVersion } from '../src/mcp/session.mjs';
import { createPayloadCapacity } from '../src/payload-capacity.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';
import { startMcpHttpServer } from '../src/mcp/http.mjs';
import { createAccountRegistry } from '../index.mjs';
import { account, backend, note, noteId } from './fixtures.mjs';

/** Let stream callbacks and asynchronous cleanup advance without elapsed-time assumptions. */
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
/** Expose a deterministic operation boundary. */
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
/** Start a real HTTP session using a deliberately small injectable process budget. */
async function serverFor(t, payloadCapacity, customBackend = backend()) {
	const config = account();
	const service = createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id);
	const server = await startMcpHttpServer({ service, bearerToken: 'capacity-test', payloadCapacity });
	t.after(() => server.close());
	return server;
}
/** Open an authenticated POST, allowing tests to delay its terminating body bytes. */
function post(server) {
	const response = deferred();
	const req = http.request(`${server.baseUrl}/mcp`, { method: 'POST', agent: false, headers: {
		Authorization: 'Bearer capacity-test', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25',
	} }, res => {
		const parts = [];
		res.on('data', part => parts.push(part));
		res.on('end', () => response.resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
	});
	req.on('error', () => {});
	return { req, response: response.promise };
}

// Output callbacks represent actual ownership release, including writes waiting behind another reply.
test('stdio retains fragmented and pipelined frames and response payloads until queued writes complete', async () => {
	const capacity = createPayloadCapacity({ limitBytes: 4096 });
	const input = new PassThrough();
	const entered = deferred();
	let releaseWrite;
	const output = new Writable({ write(_chunk, _encoding, callback) {
		if (!releaseWrite) { releaseWrite = callback; entered.resolve(); }
		else callback();
	} });
	const session = {
		async handle(message, { responsePayload }) {
			responsePayload.reserve(7);
			return { jsonrpc: '2.0', id: message.id, result: {} };
		},
		close() {},
	};
	const transport = serveStdio(session, { input, output, payloadCapacity: capacity });
	const frame = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
	input.write(frame.slice(0, 11));
	assert.equal(capacity.usedBytes, 11);
	input.write(frame.slice(11) + frame.replace('"id":1', '"id":2'));
	await entered.promise;
	await nextTurn();
	assert.equal(capacity.usedBytes, Buffer.byteLength(frame) * 2 + 14);
	releaseWrite();
	await nextTurn();
	assert.equal(capacity.usedBytes, 0);
	input.end();
	assert.equal((await transport.done).failed, false);
});

test('stdio releases discarded fragments on capacity rejection, parse errors and incomplete EOF', async () => {
	for (const [limitBytes, chunks, expectedCode, failed] of [
		[8, ['1234', '56789'], 'resource_capacity_exceeded', true],
		[128, ['{bad}\n'], undefined, false],
		[128, ['{"unfinished":'], undefined, false],
	]) {
		const capacity = createPayloadCapacity({ limitBytes });
		const input = new PassThrough();
		const output = new PassThrough();
		let text = '';
		output.on('data', chunk => { text += chunk; });
		const transport = serveStdio({ handle() { throw new Error('discarded frame dispatched'); }, close() {} }, { input, output, payloadCapacity: capacity });
		for (const chunk of chunks) input.write(chunk);
		input.end();
		assert.equal((await transport.done).failed, failed);
		assert.equal(capacity.usedBytes, 0);
		const response = JSON.parse(text);
		assert.equal(response.error.data?.code, expectedCode);
		assert.equal(response.error.code, expectedCode ? -32000 : -32700);
	}
});

test('HTTP admits fragmented collectors before dispatch and frees disconnected collectors', { timeout: 10000 }, async t => {
	const capacity = createPayloadCapacity({ limitBytes: 4096 });
	const server = await serverFor(t, capacity);
	const collecting = Array.from({ length: 8 }, () => post(server));
	t.after(() => { for (const { req } of collecting) req.destroy(); });
	for (const { req } of collecting) req.write('{');
	while (capacity.usedBytes !== 8) await nextTurn();
	const excess = post(server);
	excess.req.end('{"jsonrpc":"2.0","id":1,"method":"ping"}');
	const response = await excess.response;
	assert.equal(response.status, 503);
	assert.deepEqual(JSON.parse(response.body), { error: 'too_many_requests' });
	for (const { req } of collecting) req.destroy();
	while (capacity.usedBytes !== 0) await nextTurn();
	const next = post(server);
	next.req.end('{"jsonrpc":"2.0","id":2,"method":"ping"}');
	assert.equal((await next.response).status, 200);
	assert.equal(capacity.usedBytes, 0);
});

test('HTTP distinguishes capacity rejection from parse failure and clears partial bytes', { timeout: 10000 }, async t => {
	const capacity = createPayloadCapacity({ limitBytes: 8 });
	const server = await serverFor(t, capacity);
	const request = post(server);
	request.req.write('1234');
	while (capacity.usedBytes !== 4) await nextTurn();
	request.req.end('56789');
	const response = await request.response;
	assert.equal(response.status, 503);
	assert.equal(JSON.parse(response.body).error.data.code, 'resource_capacity_exceeded');
	assert.equal(capacity.usedBytes, 0);
});

test('HTTP disconnect after dispatch retains request and response ownership until the operation settles', { timeout: 10000 }, async t => {
	const baseCapacity = createPayloadCapacity({ limitBytes: 4096 });
	const responseReserved = deferred();
	const capacity = {
		get usedBytes() { return baseCapacity.usedBytes; },
		limitBytes: baseCapacity.limitBytes,
		createOwner(context) {
			const owner = baseCapacity.createOwner(context);
			return { ...owner, reserve(bytes) {
				owner.reserve(bytes);
				if (context.stage === 'response') responseReserved.resolve();
			} };
		},
	};
	const entered = deferred();
	const release = deferred();
	const customBackend = backend();
	let signal;
	customBackend.getNote = async (_id, operationSignal) => {
		signal = operationSignal;
		entered.resolve();
		await release.promise;
		return note;
	};
	const server = await serverFor(t, capacity, customBackend);
	t.after(() => release.resolve());
	const request = post(server);
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_note', arguments: { id: noteId, output: 'file' } } });
	request.req.end(body);
	await entered.promise;
	request.req.destroy();
	await nextTurn();
	assert.equal(signal.aborted, false);
	assert.ok(capacity.usedBytes >= Buffer.byteLength(body));
	release.resolve();
	await responseReserved.promise;
	while (capacity.usedBytes !== 0) await nextTurn();
});


test('HTTP shutdown discards unfinished collectors and releases their reservations', { timeout: 10000 }, async t => {
	const capacity = createPayloadCapacity({ limitBytes: 4096 });
	const server = await serverFor(t, capacity);
	const request = post(server);
	t.after(() => request.req.destroy());
	request.req.write('{');
	while (capacity.usedBytes !== 1) await nextTurn();
	const closing = server.close();
	assert.equal((await request.response).status, 503);
	request.req.destroy();
	await closing;
	assert.equal(capacity.usedBytes, 0);
});

test('fleet socket connections share payload capacity and exported file lifetime', { timeout: 10000 }, async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-capacity-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const capacity = createPayloadCapacity({ limitBytes: 4096 });
	const config = account();
	const service = createAccountRegistry([config], { makeBackend: () => backend() }).forPrincipal(config.id, config.id);
	const filename = path.join(directory, 'mcp.sock');
	const token = 't'.repeat(32);
	const server = await startMcpSocket({ socketPath: filename, token, service, payloadCapacity: capacity });
	t.after(() => server.close());
	/** Authenticate each independent client before sending MCP frames. */
	async function connect() {
		const socket = await connectPrivateSocket(filename);
		t.after(() => socket.destroy());
		socket.write(`${JSON.stringify({ token })}\n`);
		assert.deepEqual(await firstLine(socket), { authenticated: true });
		return socket;
	}
	/** Send one modern request without an initialization handshake. */
	async function exchange(socket, id, method, params = {}) {
		socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
			'io.modelcontextprotocol/protocolVersion': modernProtocolVersion,
			'io.modelcontextprotocol/clientCapabilities': {},
		} } })}\n`);
		return firstLine(socket, { maxBytes: 128 * 1024 });
	}
	const first = await connect();
	const exported = await exchange(first, 1, 'tools/call', { name: 'read_note', arguments: { id: noteId, output: 'file' } });
	assert.equal(exported.result.isError, false);
	const uri = exported.result.structuredContent.file.uri;
	first.destroy();
	const second = await connect();
	const listed = await exchange(second, 2, 'resources/list');
	assert.equal(listed.result.resources[0].uri, uri);
	assert.equal((await exchange(second, 3, 'resources/read', { uri })).result.contents[0].blob, Buffer.from('alice').toString('base64'));
	second.resume();
	second.write('{');
	while (capacity.usedBytes !== 1) await nextTurn();
	second.destroy();
	while (capacity.usedBytes !== 0) await nextTurn();
});
