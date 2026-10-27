import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../mcp-http.mjs', import.meta.url));
const noteId = 'a'.repeat(32);
const modernProtocolVersion = '2026-07-28';
const note = {
	id: noteId,
	parent_id: '',
	title: 'HTTP process note',
	body: 'Private API response through HTTP MCP',
	created_time: 50,
	updated_time: 100,
	is_todo: 0,
	todo_completed: 0,
	markup_language: 1,
	encryption_applied: 0,
	deleted_time: 0,
	is_locked: 0,
};

/** Check the server identity carried by a modern complete result. */
function assertServerInfo(info) {
	assert.equal(info?.name, 'joplin-headless');
	assert.equal(info?.version, '0.2.0');
	assert.equal(info?.title, 'Joplin MCP');
	assert.equal(info?.icons?.[0]?.mimeType, 'image/png');
	assert.deepEqual(info?.icons?.[0]?.sizes, ['256x256']);
	assert.ok(info?.icons?.[0]?.src.startsWith('data:image/png;base64,'));
}

/** Return an unused fixed loopback port for the child process configuration. */
async function availablePort() {
	const reservation = net.createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const port = reservation.address().port;
	await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
	return port;
}

/** Stop a child during cleanup, with a bounded fallback for a stuck process. */
async function stop(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, 'exit');
	child.kill('SIGTERM');
	const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
	try { await exited; } finally { clearTimeout(timer); }
}

/** Retry a local readiness check briefly while the child binds its listener. */
async function waitReady(baseUrl, child, maxMs = 10000) {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw Error('HTTP MCP process exited before readiness');
		try {
			const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(500) });
			if (response.ok) return await response.json();
			await response.body?.cancel();
		} catch { /* The listener may not have bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw Error('HTTP MCP process did not become ready');
}

async function post(baseUrl, bearerToken, message, protocolVersion) {
	const modern = protocolVersion === modernProtocolVersion;
	const request = modern ? {
		...message,
		params: {
			...message.params,
			_meta: {
				'io.modelcontextprotocol/protocolVersion': modernProtocolVersion,
				'io.modelcontextprotocol/clientCapabilities': {},
			},
		},
	} : message;
	const response = await fetch(`${baseUrl}/mcp`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${bearerToken}`,
			'Content-Type': 'application/json',
			Accept: modern ? 'application/json, text/event-stream' : 'application/json',
			...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
			...(modern ? {
				'Mcp-Method': message.method,
				...(message.method === 'tools/call' ? { 'Mcp-Name': message.params.name } : {}),
			} : {}),
		},
		body: JSON.stringify(request),
		signal: AbortSignal.timeout(2000),
	});
	return { response, body: await response.json() };
}

test('HTTP MCP launcher serves authenticated stateless requests and stops cleanly', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-http-process-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const apiToken = 'synthetic-private-api-token';
	const bearerToken = 'synthetic-http-bearer-token';
	const api = http.createServer(async (req, res) => {
		const target = new URL(req.url, 'http://127.0.0.1');
		if (target.searchParams.get('token') !== apiToken) {
			res.writeHead(401).end();
			return;
		}
		res.setHeader('Content-Type', 'application/json');
		if (req.method === 'POST' && target.pathname === '/services/headless') {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const action = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			if (action.action === 'readNote') {
				res.end(JSON.stringify({ ...note, revision_id: '0'.repeat(31) + '1' }));
			} else {
				res.writeHead(400).end('{}');
			}
		} else if (req.method === 'GET' && target.pathname === '/notes') {
			res.end(JSON.stringify({ items: [], has_more: false }));
		} else if (req.method === 'GET' && target.pathname === `/notes/${noteId}`) {
			res.end(JSON.stringify(note));
		} else if (req.method === 'GET' && target.pathname === `/notes/${noteId}/tags`) {
			res.end(JSON.stringify({ items: [], has_more: false }));
		} else {
			res.writeHead(404).end();
		}
	});
	api.listen(0, '127.0.0.1');
	await once(api, 'listening');
	t.after(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });

	const apiTokenFile = path.join(dir, 'api-token');
	const bearerTokenFile = path.join(dir, 'bearer-token');
	const configFile = path.join(dir, 'mcp.json');
	const port = await availablePort();
	fs.writeFileSync(apiTokenFile, apiToken, { mode: 0o600 });
	fs.writeFileSync(bearerTokenFile, bearerToken, { mode: 0o600 });
	fs.writeFileSync(configFile, JSON.stringify({
		accountId: 'http-test',
		baseUrl: `http://127.0.0.1:${api.address().port}`,
		apiTokenFile,
		bearerTokenFile,
		listenHost: '127.0.0.1',
		listenPort: port,
	}));

	const child = spawn(process.execPath, [executable, configFile], { stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
	t.after(() => stop(child));
	const baseUrl = `http://127.0.0.1:${port}`;
	assert.deepEqual(await waitReady(baseUrl, child), { ready: true });

	const unauthorized = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	assert.equal(unauthorized.status, 401);
	await unauthorized.body?.cancel();

	const initialized = await post(baseUrl, bearerToken, {
		jsonrpc: '2.0', id: 1, method: 'initialize',
		params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'process-test', version: '1' } },
	});
	assert.equal(initialized.response.status, 200);
	assert.equal(initialized.body.result.protocolVersion, '2025-11-25');

	const listed = await post(baseUrl, bearerToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '2025-11-25');
	assert.equal(listed.response.status, 200);
	assert.ok(listed.body.result.tools.some(tool => tool.name === 'read_note'));

	const read = await post(baseUrl, bearerToken, {
		jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_note', arguments: { id: noteId } },
	}, '2025-11-25');
	assert.equal(read.response.status, 200);
	assert.equal(read.body.result.structuredContent.body, note.body);

	const discovered = await post(baseUrl, bearerToken, {
		jsonrpc: '2.0', id: 4, method: 'server/discover', params: {},
	}, modernProtocolVersion);
	assert.equal(discovered.response.status, 200);
	assert.equal(discovered.body.result.resultType, 'complete');
	assert.ok(discovered.body.result.supportedVersions.includes(modernProtocolVersion));
	assert.ok(discovered.body.result.supportedVersions.includes('2025-11-25'));
	assert.deepEqual(discovered.body.result.capabilities, { tools: {}, resources: {} });
	assert.equal(discovered.body.result.ttlMs, 0);
	assert.equal(discovered.body.result.cacheScope, 'private');
	assertServerInfo(discovered.body.result._meta?.['io.modelcontextprotocol/serverInfo']);

	const modernRead = await post(baseUrl, bearerToken, {
		jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_note', arguments: { id: noteId } },
	}, modernProtocolVersion);
	assert.equal(modernRead.response.status, 200);
	assert.equal(modernRead.body.result.resultType, 'complete');
	assertServerInfo(modernRead.body.result._meta?.['io.modelcontextprotocol/serverInfo']);
	assert.equal(modernRead.body.result.structuredContent.body, note.body);

	const exited = once(child, 'exit');
	const exitTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
	child.kill('SIGTERM');
	let code; let signal;
	try { [code, signal] = await exited; } finally { clearTimeout(exitTimer); }
	assert.equal(code, 0, `HTTP MCP process exit ${code} signal ${signal}; stderr retained for redaction checks`);
	assert.doesNotMatch(stderr, new RegExp(`${apiToken}|${bearerToken}|${configFile}|${new URL(`http://127.0.0.1:${api.address().port}`).href}`));
});
