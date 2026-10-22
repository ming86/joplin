import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StdioTestClient } from '../scripts/lib/stdio-client.mjs';

const cli = process.env.JOPLIN_MCP_TEST_CLI;
const sqliteModule = process.env.JOPLIN_HEADLESS_SQLITE_MODULE;

test('MCP over stdio -> actual encrypted Joplin API, FTS, E2EE filesystem sync and normal-mode client', {
	skip: !cli || !sqliteModule ? 'Set JOPLIN_MCP_TEST_CLI and JOPLIN_HEADLESS_SQLITE_MODULE to the installed encrypted runtime.' : false,
	timeout: 180000,
}, async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-mcp-native-'));
	const key = randomBytes(32).toString('hex');
	const token = randomBytes(32).toString('hex');
	const password = randomBytes(24).toString('hex'); // Disposable test identity only, never an existing user key.
	const profile = path.join(dir, 'headless'); const normalProfile = path.join(dir, 'normal'); const syncPath = path.join(dir, 'sync');
	fs.mkdirSync(syncPath); fs.mkdirSync(path.join(dir, 'home'));
	const headlessEnv = { ...process.env, HOME: path.join(dir, 'home'), JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: profile, JOPLIN_HEADLESS_KEY_FD: '3' };
	const children = new Set();
	async function stop(child) {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const closed = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
		await closed; clearTimeout(timer);
	}
	t.after(async () => { for (const c of children) await stop(c); fs.rmSync(dir, { recursive: true, force: true }); });
	function start(args, input = '', headless = true) {
		const env = { ...headlessEnv };
		if (!headless) { delete env.JOPLIN_HEADLESS; delete env.JOPLIN_HEADLESS_PROFILE; delete env.JOPLIN_HEADLESS_KEY_FD; }
		const child = spawn(process.execPath, [cli, ...(!headless ? ['--profile', normalProfile] : []), ...args], { env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
		children.add(child);
		child.out = ''; child.err = '';
		child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
		child.stdout.on('data', data => { child.out += data; }); child.stderr.on('data', data => { child.err += data; });
		child.stdio[3].end(headless ? `${key}\n` : ''); child.stdin.end(input);
		return child;
	}
	async function command(args, input = '', headless = true) {
		const child = start(args, input, headless); const closed = once(child, 'exit');
		const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
		const [code, signal] = await closed; clearTimeout(timer);
		assert.equal(code, 0, `CLI ${args[0]} exit ${code} signal ${signal}; diagnostics retained in memory only`);
		return child.out;
	}
	async function until(check, message, maxMs = 50000) {
		const end = Date.now() + maxMs;
		while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 250)); }
		assert.fail(message);
	}
	const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
	const port = portServer.address().port; await new Promise(r => portServer.close(r));
	const baseUrl = `http://127.0.0.1:${port}`;
	await command(['config', '--import'], JSON.stringify({ 'sync.target': 2, 'sync.2.path': syncPath, 'api.port': port, 'api.token': token }));
	// Upstream testing flag with a freshly generated disposable secret; nothing logged or uploaded.
	await command(['e2ee', 'enable', '--password', password]);
	assert.match(await command(['e2ee', 'status']), /Enabled/);
	await command(['sync']); // Initial target/key setup before measuring MCP, not used to force MCP changes.
	const daemon = start(['serve']);
	await until(() => daemon.out.includes('headless: private API ready'), 'headless API did not become ready');
	async function raw(route, method = 'GET', data) {
		const url = new URL(route, baseUrl); url.searchParams.set('token', token);
		const res = await fetch(url, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
		assert.equal(res.ok, true, `Setup API HTTP ${res.status}`); return res.json();
	}
	const unauthorized = await fetch(`${baseUrl}/notes`); assert.ok([401, 403].includes(unauthorized.status)); await unauthorized.body?.cancel();
	const notebook = await raw('/folders', 'POST', { title: 'Disposable MCP acceptance' });
	const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
	const configFile = path.join(dir, 'mcp.json');
	const conf = { accountId: 'acceptance', baseUrl, apiTokenFile: tokenFile, allowWrites: true };
	fs.writeFileSync(configFile, JSON.stringify(conf));
	const mcp = new StdioTestClient(configFile); t.after(() => mcp.close());
	await mcp.initialize();
	assert.equal((await mcp.request('tools/list')).tools.length, 8);
	const marker = `mcpacceptance${randomBytes(6).toString('hex')}`;
	let result = await mcp.call('create_note', { parentId: notebook.id, title: 'MCP temporary note', body: `${marker} initial 笔记` });
	assert.equal(result.isError, false, JSON.stringify(result)); const noteId = result.structuredContent.note.id;
	assert.equal(result.structuredContent.synchronization, 'not_confirmed');
	result = await mcp.call('update_note', { id: noteId, body: `${marker} revised 😀` }); assert.equal(result.isError, false);
	result = await mcp.call('get_note', { id: noteId }); assert.equal(result.structuredContent.body, `${marker} revised 😀`);
	await until(async () => (await mcp.call('search_notes', { query: marker })).structuredContent.items.some(n => n.id === noteId), 'MCP change not in real FTS');
	assert.equal((await mcp.call('search_notes', { query: marker, mode: 'semantic' })).structuredContent.semantic.state, 'unavailable');
	t.diagnostic('PASS MCP initialization/list/read/create/update/FTS through actual encrypted core');
	await until(() => fs.existsSync(path.join(syncPath, `${noteId}.md`)), 'MCP change did not synchronize autonomously');
	const synchronized = fs.readFileSync(path.join(syncPath, `${noteId}.md`), 'utf8');
	assert.ok(synchronized.includes('encryption_applied: 1')); assert.ok(!synchronized.includes(marker));
	// Normal storage/client mode of the same binary, not a separately built unmodified upstream client.
	await command(['config', '--import'], JSON.stringify({ 'sync.target': 2, 'sync.2.path': syncPath, 'encryption.masterPassword': password }), false);
	await command(['sync'], '', false); await command(['e2ee', 'decrypt', '--force'], '', false);
	assert.ok((await command(['cat', noteId], '', false)).includes(`${marker} revised`));
	assert.equal(daemon.exitCode, null);
	t.diagnostic('PASS MCP-written note automatically E2EE-synced over filesystem and read by normal-mode client');
	await mcp.close();
	conf.allowWrites = false; fs.writeFileSync(configFile, JSON.stringify(conf));
	const reader = new StdioTestClient(configFile); t.after(() => reader.close()); await reader.initialize();
	assert.equal((await reader.request('tools/list')).tools.length, 5);
	await assert.rejects(reader.call('create_note', { parentId: notebook.id, title: 'blocked', body: '' }), { rpcCode: -32602 });
	assert.equal((await reader.call('get_note', { id: noteId, accountId: 'other' })).isError, true);
	await reader.close(); await stop(daemon); assert.equal(daemon.exitCode, 0);
	assert.ok(!fs.readFileSync(path.join(profile, 'database.sqlite')).includes(Buffer.from(marker)));
	const restarted = start(['serve']); await until(() => restarted.out.includes('headless: private API ready'), 'restart API unready');
	const again = new StdioTestClient(configFile); t.after(() => again.close()); await again.initialize();
	assert.equal((await again.call('get_note', { id: noteId })).structuredContent.body, `${marker} revised 😀`);
	await again.close(); await stop(restarted); assert.equal(restarted.exitCode, 0);
	t.diagnostic('PASS read-only enforcement, account-argument rejection and encrypted-core restart persistence');
});
