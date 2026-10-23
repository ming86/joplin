import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { createAccountRegistry, ServiceError } from '../index.mjs';
import { startMcpHttpServer } from '../src/mcp/http.mjs';
import { createMcpSession } from '../src/mcp/session.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';
import { account, backend, noteId } from './fixtures.mjs';

/** Capture structured diagnostics without exposing them to the test runner output. */
async function captureLogs(run) {
	const original = console.error;
	const entries = [];
	console.error = (...args) => entries.push(args);
	try { return { value: await run(), entries }; }
	finally { console.error = original; }
}

/** Bind a synthetic backend to the same account adapter used by the MCP service. */
function serviceFor(customBackend) {
	const config = account();
	return createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id);
}

function parseLog(entries, count = 1) {
	assert.equal(entries.length, count);
	assert.equal(entries[0].length, 1);
	return JSON.parse(entries[0][0]);
}

test('tool failures log once with tool and backend diagnostics while retaining the safe result', async () => {
	const cause = new Error('private backend payload');
	const customBackend = backend();
	customBackend.getNote = async () => {
		throw new ServiceError('backend_unavailable', false, 'backend_unavailable', {
			cause,
			diagnostics: { method: 'GET', path: '/notes', status: 503 },
		});
	};
	const session = createMcpSession(serviceFor(customBackend), { stateless: true });
	try {
		const { value, entries } = await captureLogs(() => session.handle({
			jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_note', arguments: { id: noteId } },
		}));
		assert.equal(value.result.structuredContent.error.code, 'backend_unavailable');
		const log = parseLog(entries);
		assert.equal(log.tool, 'get_note');
		assert.equal(log.method, 'GET');
		assert.equal(log.path, '/notes');
		assert.equal(log.status, 503);
		assert.equal(log.errors[0].code, 'backend_unavailable');
		assert.ok(!JSON.stringify(log).includes('private backend payload'));
	} finally { session.close(); }
});

test('expected tool validation failures stay quiet', async () => {
	const customBackend = backend();
	customBackend.getNote = async () => { throw new ServiceError('validation_error'); };
	const session = createMcpSession(serviceFor(customBackend), { stateless: true });
	try {
		const { value, entries } = await captureLogs(() => session.handle({
			jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_note', arguments: { id: noteId } },
		}));
		assert.equal(value.result.structuredContent.error.code, 'validation_error');
		assert.equal(entries.length, 0);
	} finally { session.close(); }
});

test('HTTP readiness logs backend diagnostics and keeps its existing unavailable response', async t => {
	const customBackend = backend();
	customBackend.listNoteSummaries = async () => {
		throw new ServiceError('backend_unavailable', false, 'backend_unavailable', {
			diagnostics: { method: 'GET', path: '/notes', status: 503 },
		});
	};
	const server = await startMcpHttpServer({ service: serviceFor(customBackend), bearerToken: 'test-token' });
	t.after(() => server.close());
	const { value: response, entries } = await captureLogs(() => fetch(`${server.baseUrl}/readyz`));
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { ready: false });
	const log = parseLog(entries);
	assert.equal(log.operation, 'readyz');
	assert.equal(log.method, 'GET');
	assert.equal(log.path, '/notes');
	assert.equal(log.status, 503);
});

test('session tool-call escapes are logged with tool context and preserve the operation-failed result', async () => {
	const session = createMcpSession(serviceFor(backend()), { stateless: true });
	const arguments_ = new Proxy({}, {
		ownKeys() { throw new Error('private argument getter'); },
	});
	try {
		const { value, entries } = await captureLogs(() => session.handle({
			jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_note', arguments: arguments_ },
		}));
		assert.equal(value.result.structuredContent.error.code, 'operation_failed');
		const log = parseLog(entries);
		assert.equal(log.tool, 'get_note');
		assert.equal(log.operation, 'mcp_tools_call');
		assert.ok(!JSON.stringify(log).includes('private argument getter'));
	} finally { session.close(); }
});

test('stdio logs an escaped session error to stderr and keeps stdout valid JSON-RPC', async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let outputText = '';
	output.on('data', chunk => { outputText += chunk.toString('utf8'); });
	const transport = serveStdio({
		async handle() { throw new Error('private session failure'); },
		close() {},
	}, { input, output });
	const { value, entries } = await captureLogs(async () => {
		input.end('{"jsonrpc":"2.0","id":4,"method":"ping"}\n');
		return transport.done;
	});
	assert.equal(value.failed, false);
	const response = JSON.parse(outputText.trim());
	assert.deepEqual(response, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
	const log = parseLog(entries);
	assert.equal(log.operation, 'stdio');
	assert.ok(!outputText.includes('private session failure'));
});
