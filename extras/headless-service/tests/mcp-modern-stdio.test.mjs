import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAccountRegistry } from '../index.mjs';
import { createMcpSession, modernProtocolVersion, protocolVersions } from '../src/mcp/session.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';
import { account, backend, noteId } from './fixtures.mjs';

const modernMeta = {
	'io.modelcontextprotocol/protocolVersion': modernProtocolVersion,
	'io.modelcontextprotocol/clientCapabilities': {},
};
const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params: { ...params, _meta: modernMeta } });

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

function createSession(customBackend = backend(), allowWrites = false) {
	const config = account();
	const service = createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id);
	return createMcpSession(service, { allowWrites });
}

/** Check the server identity carried by a modern complete result. */
function assertServerInfo(info) {
	assert.equal(info?.name, 'joplin-headless');
	assert.equal(info?.version, '0.2.0');
	assert.equal(info?.title, 'Joplin MCP');
	assert.equal(info?.icons?.[0]?.mimeType, 'image/png');
	assert.deepEqual(info?.icons?.[0]?.sizes, ['256x256']);
	assert.ok(info?.icons?.[0]?.src.startsWith('data:image/png;base64,'));
}

function createWire(session) {
	const input = new PassThrough();
	const output = new PassThrough();
	const responses = [];
	const waiting = new Map();
	let buffer = '';
	const transport = serveStdio(session, { input, output });
	output.on('data', chunk => {
		buffer += chunk.toString('utf8');
		let boundary;
		while ((boundary = buffer.indexOf('\n')) !== -1) {
			const response = JSON.parse(buffer.slice(0, boundary));
			buffer = buffer.slice(boundary + 1);
			responses.push(response);
			const waiter = waiting.get(response.id);
			if (waiter) {
				waiting.delete(response.id);
				waiter.resolve(response);
			}
		}
	});
	transport.done.then(result => {
		for (const [id, waiter] of waiting) {
			waiting.delete(id);
			waiter.reject(new Error(`stdio closed before response ${String(id)} (failed=${result.failed})`));
		}
	});
	return {
		responses,
		request(message) {
			const response = new Promise((resolve, reject) => {
				if (waiting.has(message.id)) return reject(new Error(`duplicate wire request id ${String(message.id)}`));
				waiting.set(message.id, { resolve, reject });
			});
			input.write(`${JSON.stringify(message)}\n`);
			return response;
		},
		send(message) { input.write(`${JSON.stringify(message)}\n`); },
		end() { input.end(); return transport.done; },
		close() { return transport.close(); },
	};
}

test('stdio serves modern discovery, tool listing and tool calls without initialize', async t => {
	const wire = createWire(createSession());
	t.after(() => wire.close());

	const discovery = (await wire.request(request(1, 'server/discover'))).result;
	assert.equal(discovery.resultType, 'complete');
	assert.ok(protocolVersions.includes(modernProtocolVersion));
	assert.ok(discovery.supportedVersions.includes(modernProtocolVersion));
	assert.ok(discovery.supportedVersions.includes('2025-11-25'));
	assert.deepEqual(discovery.capabilities, { tools: {}, resources: {} });
	assert.equal(discovery.ttlMs, 0);
	assert.equal(discovery.cacheScope, 'private');
	assertServerInfo(discovery._meta?.['io.modelcontextprotocol/serverInfo']);

	const listing = (await wire.request(request(2, 'tools/list'))).result;
	assert.equal(listing.resultType, 'complete');
	assert.equal(listing.ttlMs, 0);
	assert.equal(listing.cacheScope, 'private');
	assertServerInfo(listing._meta?.['io.modelcontextprotocol/serverInfo']);
	assert.ok(listing.tools.some(tool => tool.name === 'get_status'));

	const call = (await wire.request(request(3, 'tools/call', { name: 'get_status', arguments: {} }))).result;
	assert.equal(call.resultType, 'complete');
	assertServerInfo(call._meta?.['io.modelcontextprotocol/serverInfo']);
	assert.ok(Array.isArray(call.content));
	assert.equal(call.isError, false);
	assert.equal(call.structuredContent.accountId, 'alice');
});

test('stdio suppresses a cancelled modern tool reply', async () => {
	const started = deferred();
	const aborted = deferred();
	const settled = deferred();
	const customBackend = backend();
	customBackend.getNote = async (_id, signal) => {
		started.resolve();
		try {
			await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
			aborted.resolve();
			throw new Error('cancelled');
		} finally { settled.resolve(); }
	};
	const wire = createWire(createSession(customBackend));

	wire.send(request('slow', 'tools/call', { name: 'get_note', arguments: { id: noteId } }));
	await started.promise;
	wire.send({
		jsonrpc: '2.0',
		method: 'notifications/cancelled',
		params: { requestId: 'slow', _meta: modernMeta },
	});
	await aborted.promise;
	await settled.promise;
	await wire.end();

	assert.equal(wire.responses.some(response => response.id === 'slow'), false);
});

test('stdio returns a response larger than the former output cap', async t => {
	const payload = 'x'.repeat(2 * 1024 * 1024);
	const fakeSession = {
		async handle(message) { return { jsonrpc: '2.0', id: message.id, result: { payload } }; },
		close() {},
	};
	const wire = createWire(fakeSession);
	t.after(() => wire.close());

	const response = await wire.request(request('large', 'ping'));
	assert.equal(response.result.payload.length, payload.length);
	assert.ok(Buffer.byteLength(`${JSON.stringify(response)}\n`) > 2 * 1024 * 1024);
});
