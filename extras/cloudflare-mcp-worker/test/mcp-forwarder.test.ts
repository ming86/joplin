import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mcpForwarder } from '../src/mcp-forwarder.js';

type RateLimitBinding = {
	limit: (input: { key: string }) => Promise<{ success: boolean }>;
};

type ForwarderEnv = {
	JOPLIN_MCP: Fetcher;
	JOPLIN_MCP_BEARER_TOKEN: string;
	MCP_RATE_LIMITER: RateLimitBinding;
};

/** Substitute the private service binding without changing global OAuth HTTP fetches. */
let sidecarFetch: Fetcher['fetch'] = async () => {
	throw new Error('Unexpected sidecar request');
};
const limiterInput: Array<{ key: string }> = [];
let rateLimitSuccess = true;

function makeEnv(overrides: Partial<ForwarderEnv> = {}): ForwarderEnv {
	return {
		JOPLIN_MCP: {
			fetch: (input, init) => sidecarFetch(input, init),
			connect: () => { throw new Error('Unexpected TCP connection'); },
		},
		JOPLIN_MCP_BEARER_TOKEN: 'sidecar-secret',
		MCP_RATE_LIMITER: {
			limit: async input => {
				limiterInput.push(input);
				return { success: rateLimitSuccess };
			},
		},
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

afterEach(() => {
	sidecarFetch = async () => { throw new Error('Unexpected sidecar request'); };
	limiterInput.length = 0;
	rateLimitSuccess = true;
});

test('forwards only the fixed MCP request and sidecar response metadata', async () => {
	let fetchTarget: URL | undefined;
	let fetchInit: RequestInit | undefined;
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

	const response = await mcpForwarder(request, makeEnv());

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
	assert.deepEqual(limiterInput, [{ key: 'joplin-mcp' }]);
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
	assert.deepEqual(limiterInput, []);
});

test('returns 429 when the shared account rate limit is exhausted', async () => {
	rateLimitSuccess = false;
	let calls = 0;
	sidecarFetch = async () => {
		calls += 1;
		return new Response('unexpected');
	};

	const response = await mcpForwarder(makeRequest(), makeEnv());

	assert.equal(response.status, 429);
	assert.equal(response.headers.get('retry-after'), '60');
	assert.equal(await response.text(), '{"error":"rate_limited"}');
	assert.equal(calls, 0);
	assert.deepEqual(limiterInput, [{ key: 'joplin-mcp' }]);
});

test('returns a fixed 502 and does not retry a failed sidecar request', async () => {
	let calls = 0;
	sidecarFetch = async () => {
		calls += 1;
		throw new Error('sensitive upstream details');
	};

	const response = await mcpForwarder(makeRequest(), makeEnv());

	assert.equal(calls, 1);
	assert.equal(response.status, 502);
	assert.equal(await response.text(), '{"error":"upstream_unavailable"}');
	assert.equal(response.headers.get('cache-control'), 'no-store');
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
