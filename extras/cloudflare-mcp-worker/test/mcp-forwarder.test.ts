import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mcpForwarder } from '../src/mcp-forwarder.js';

type ForwarderEnv = {
	JOPLIN_MCP: Fetcher;
	JOPLIN_MCP_BEARER_TOKEN: string;
};

/** Substitute the private service binding without changing global OAuth HTTP fetches. */
let sidecarFetch: Fetcher['fetch'] = async () => {
	throw new Error('Unexpected sidecar request');
};

function makeEnv(overrides: Partial<ForwarderEnv> = {}): ForwarderEnv {
	return {
		JOPLIN_MCP: {
			fetch: (input, init) => sidecarFetch(input, init),
			connect: () => { throw new Error('Unexpected TCP connection'); },
		},
		JOPLIN_MCP_BEARER_TOKEN: 'sidecar-secret',
		...overrides,
	};
}

function makeRequest(path = '/mcp', init: RequestInit = {}): Request {
	return new Request(`https://oauth.example.test${path}`, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer oauth-client-token',
			Cookie: 'session=client-cookie',
			'Content-Type': 'application/json',
			'Content-Encoding': 'identity',
			Accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2026-07-28',
			'Mcp-Method': 'tools/call',
			'Mcp-Name': 'create_note',
			Origin: 'https://client.example.test',
			'X-Forwarded-For': '198.51.100.7',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }),
		...init,
	});
}

/** Capture the forwarder's structured error events without changing their runtime behavior. */
async function captureErrorLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
	const logs: string[] = [];
	const originalError = console.error;
	console.error = ((message: unknown) => {
		if (typeof message === 'string') logs.push(message);
	}) as typeof console.error;
	try {
		return { result: await run(), logs };
	} finally {
		console.error = originalError;
	}
}

afterEach(() => {
	sidecarFetch = async () => { throw new Error('Unexpected sidecar request'); };
});

test('forwards authenticated MCP requests without using the registration rate limiter', async () => {
	let fetchTarget: URL | undefined;
	let fetchInit: RequestInit | undefined;
	let limiterCalls = 0;
	const request = makeRequest('/mcp?route=/admin', {
		headers: {
			Authorization: 'Bearer another-oauth-token',
			Cookie: 'session=another-client-cookie',
			'Content-Type': 'application/json',
			'Content-Encoding': 'identity',
			Accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2026-07-28',
			'Mcp-Method': 'tools/call',
			'Mcp-Name': 'create_note',
			Origin: 'https://client.example.test',
			'X-Forwarded-For': '198.51.100.7',
		},
	});
	const body = request.clone().text();
	sidecarFetch = async (input, init) => {
		fetchTarget = new URL(String(input));
		fetchInit = init;
		return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Session-Id': 'sidecar-session',
				Allow: 'POST',
				'Retry-After': '15',
				'WWW-Authenticate': 'Bearer realm="private-sidecar"',
				'Cache-Control': 'public, max-age=3600',
			},
		});
	};

	const env = {
		...makeEnv(),
		MCP_RATE_LIMITER: {
			limit: async () => {
				limiterCalls += 1;
				return { success: false };
			},
		},
	};
	const response = await mcpForwarder(request, env);

	assert.equal(fetchTarget?.href, 'http://localhost:41191/mcp');
	assert.equal(fetchInit?.method, 'POST');
	assert.equal(fetchInit?.redirect, 'manual');
	assert.equal(await new Response(fetchInit?.body as BodyInit).text(), await body);
	const forwardedHeaders = new Headers(fetchInit?.headers);
	assert.equal(forwardedHeaders.get('authorization'), 'Bearer sidecar-secret');
	assert.equal(forwardedHeaders.get('content-type'), 'application/json');
	assert.equal(forwardedHeaders.get('content-encoding'), 'identity');
	assert.equal(forwardedHeaders.get('accept'), 'application/json, text/event-stream');
	assert.equal(forwardedHeaders.get('mcp-protocol-version'), '2026-07-28');
	assert.equal(forwardedHeaders.get('mcp-method'), 'tools/call');
	assert.equal(forwardedHeaders.get('mcp-name'), 'create_note');
	assert.equal(forwardedHeaders.get('origin'), 'https://client.example.test');
	assert.equal(forwardedHeaders.has('cookie'), false);
	assert.equal(forwardedHeaders.has('x-forwarded-for'), false);
	assert.equal(limiterCalls, 0);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), '{"jsonrpc":"2.0","id":1,"result":{}}');
	assert.equal(response.headers.get('content-type'), 'application/json');
	assert.equal(response.headers.get('mcp-protocol-version'), '2026-07-28');
	assert.equal(response.headers.get('mcp-session-id'), 'sidecar-session');
	assert.equal(response.headers.get('allow'), 'POST');
	assert.equal(response.headers.get('retry-after'), '15');
	assert.equal(response.headers.get('www-authenticate'), null);
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('rejects other paths and methods without contacting the sidecar', async () => {
	let calls = 0;
	sidecarFetch = async () => {
		calls += 1;
		return new Response('unexpected');
	};

	const pathResponse = await mcpForwarder(makeRequest('/admin'), makeEnv());
	const methodResponse = await mcpForwarder(makeRequest('/mcp', { method: 'GET', body: undefined }), makeEnv());

	assert.equal(pathResponse.status, 404);
	assert.equal(methodResponse.status, 405);
	assert.equal(methodResponse.headers.get('allow'), 'POST');
	assert.equal(calls, 0);
});

test('logs safe sidecar cause metadata without error headlines and does not retry or change the 502 response', async () => {
	let calls = 0;
	sidecarFetch = async () => {
		calls += 1;
		const cause = Object.assign(new Error('PRIVATE_NOTE_TEXT https://sidecar.example.test/mcp?access_token=private-query'), {
			code: 'ECONNREFUSED',
			errno: -111,
			syscall: 'connect',
		});
		const wrapper = new Error('upstream rejected PRIVATE_ERROR_HEADLINE');
		Object.defineProperty(wrapper, 'cause', { value: cause });
		const error = new TypeError('fetch failed');
		Object.defineProperty(error, 'cause', { value: wrapper });
		error.stack = 'TypeError: fetch failed PRIVATE_STACK_HEADLINE\n    at mcpForwarder (file:///safe/forwarder.js?token=private-query:10:2)\n    at call (file:///safe/forwarder.js:11:3)';
		throw error;
	};

	const request = makeRequest('/mcp?route=private-route', {
		body: '{"text":"private-request-note-body"}',
	});
	const { result: response, logs } = await captureErrorLogs(() => mcpForwarder(request, makeEnv()));

	assert.equal(calls, 1);
	assert.equal(response.status, 502);
	assert.equal(await response.text(), '{"error":"upstream_unavailable"}');
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal(logs.length, 1);
	const log = JSON.parse(logs[0]!) as {
		event: string;
		operation: string;
		layer: string;
		elapsed_ms: number;
		error: {
			name: string;
			message?: string;
			stack?: string[];
			cause: {
				name: string;
				message?: string;
				cause: { code: string; errno: number; syscall: string; message?: string };
			};
		};
	};
	assert.equal(log.event, 'mcp_forwarding_failure');
	assert.equal(log.operation, 'forward_mcp');
	assert.equal(log.layer, 'vpc_service_binding');
	assert.equal(typeof log.elapsed_ms, 'number');
	assert.equal(log.error.name, 'TypeError');
	assert.equal(log.error.message, 'fetch failed');
	assert.deepEqual(log.error.stack, ['file:///safe/forwarder.js:11:3']);
	assert.equal(log.error.cause.message, undefined);
	assert.equal(log.error.cause.cause.code, 'ECONNREFUSED');
	assert.equal(log.error.cause.cause.errno, -111);
	assert.equal(log.error.cause.cause.syscall, 'connect');
	assert.equal(log.error.cause.cause.message, undefined);
	assert.doesNotMatch(JSON.stringify(log), /PRIVATE_NOTE_TEXT|PRIVATE_ERROR_HEADLINE|PRIVATE_STACK_HEADLINE|private-query|private-request-note-body|private-route/);
});

test('logs upstream auth and server statuses without logging ordinary client rejections', async () => {
	const upstreamResponses = [
		new Response('private authentication response', { status: 401 }),
		new Response('private server response', { status: 503 }),
		new Response('private client response', { status: 400 }),
	];
	sidecarFetch = async () => upstreamResponses.shift()!;

	const { result: responses, logs } = await captureErrorLogs(async () => Promise.all([
		mcpForwarder(makeRequest(), makeEnv()),
		mcpForwarder(makeRequest(), makeEnv()),
		mcpForwarder(makeRequest(), makeEnv()),
	]));

	assert.deepEqual(responses.map(response => response.status), [401, 503, 400]);
	assert.deepEqual(await Promise.all(responses.map(response => response.text())), [
		'private authentication response',
		'private server response',
		'private client response',
	]);
	assert.equal(logs.length, 2);
	const entries = logs.map(log => JSON.parse(log) as { operation: string; layer: string; elapsed_ms: number; status: number });
	assert.deepEqual(entries.map(entry => entry.status), [401, 503]);
	for (const entry of entries) {
		assert.equal(entry.operation, 'forward_mcp');
		assert.equal(entry.layer, 'upstream_http');
		assert.equal(typeof entry.elapsed_ms, 'number');
	}
});

test('returns the sidecar write outcome without cancelling or retrying it', async () => {
	let calls = 0;
	let fetchSignal: AbortSignal | undefined;
	sidecarFetch = async (_input, init) => {
		calls += 1;
		fetchSignal = init?.signal ?? undefined;
		return new Response('{"result":{"written":true}}', { status: 201 });
	};

	const response = await mcpForwarder(makeRequest(), makeEnv());

	assert.equal(calls, 1);
	assert.equal(fetchSignal, undefined);
	assert.equal(response.status, 201);
	assert.equal(await response.text(), '{"result":{"written":true}}');
});
