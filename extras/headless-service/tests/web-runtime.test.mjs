import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StdioTestClient } from '../scripts/lib/stdio-client.mjs';
import { server, readJson, note, folderId } from './fixtures.mjs';
import { PREVIEW_STYLE } from '../web/preview.mjs';
import { createRequire } from 'node:module';
const renderer = process.env.JOPLIN_WEB_MARKDOWN_MODULE ?? createRequire(new URL('../../../packages/renderer/package.json', import.meta.url)).resolve('markdown-it');
const entry = fileURLToPath(new URL('../web.mjs', import.meta.url));
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
async function config(t, baseUrl, sameToken = false) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-web-runtime-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const token = randomBytes(32).toString('hex'), webToken = sameToken ? token : randomBytes(32).toString('hex');
	const coreTokenFile = path.join(dir, 'core-token'), webTokenFile = path.join(dir, 'web-token'), accountConfigFile = path.join(dir, 'account.json'), filename = path.join(dir, 'web.json');
	fs.writeFileSync(coreTokenFile, token, { mode: 0o600 }); fs.writeFileSync(webTokenFile, webToken, { mode: 0o600 });
	fs.writeFileSync(accountConfigFile, JSON.stringify({ accountId: 'runtime-test', baseUrl, apiTokenFile: coreTokenFile, allowWrites: true }));
	const port = await freePort(), origin = `http://127.0.0.1:${port}`;
	fs.writeFileSync(filename, JSON.stringify({ accountConfigFile, webTokenFile, namespace: randomBytes(16).toString('hex'), port, publicOrigin: origin, markdownModule: renderer, stdio: true }));
	return { filename, token, webToken, origin };
}
test('launched web entry shares account with stdio MCP; metadata reads, preview, write and shutdown use real HTTP', async t => {
	const notes = new Map([[note.id, { ...note }]]); const writes = []; let conf;
	const baseUrl = await server(t, async (req, res) => {
		const u = new URL(req.url, 'http://localhost'); assert.equal(u.searchParams.get('token'), conf.token);
		const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
		if (req.method === 'POST' && u.pathname === '/notes') {
			const body = await readJson(req); assert.equal(body.body, ''); writes.push('POST');
			notes.set(body.id, { ...note, ...body }); return send(notes.get(body.id));
		}
		if (req.method === 'PUT') { const body = await readJson(req); const saved = notes.get(u.pathname.split('/').pop()); Object.assign(saved, body); saved.updated_time++; writes.push('PUT'); return send(saved); }
		if (u.pathname === '/notes') {
			const fields = u.searchParams.get('fields').split(','); assert.equal(fields.includes('body'), false);
			return send({ items: [...notes.values()].map(n => Object.fromEntries(fields.map(k => [k, n[k]]))), has_more: false });
		}
		if (u.pathname.startsWith('/notes/')) { const n = notes.get(u.pathname.split('/').pop()); if (!n) { res.writeHead(404); res.end('{}'); return; } return send(n); }
		if (u.pathname.startsWith('/folders/')) return send({ id: folderId, title: 'Test folder' });
		if (u.pathname === '/folders') return send({ items: [{ id: folderId, title: 'Test folder', parent_id: '' }], has_more: false });
		res.writeHead(404); res.end('{}');
	});
	conf = await config(t, baseUrl); const client = new StdioTestClient(conf.filename, entry); t.after(() => client.close());
	await client.initialize(); assert.equal((await client.request('tools/list')).tools.length, 8);
	const login = await fetch(conf.origin + '/api/login', { method: 'POST', headers: { Origin: conf.origin, 'X-Joplin-Web': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: conf.webToken }) });
	assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0]; await login.json();
	const headers = { Origin: conf.origin, 'X-Joplin-Web': '1', 'Content-Type': 'application/json', Cookie: cookie };
	const list = await (await fetch(conf.origin+'/api/notes', { headers })).json(); assert.equal(list.items[0].body, undefined);
	const input = { kind: 'create', operationId: 'c'.repeat(32), notebookId: folderId, title: 'Web runtime', body: '# Heading\r\n![image](https://example.invalid/private.png)\r\n' };
	const save = await fetch(conf.origin+'/api/write', { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(save.status, 200); const result = await save.json();
	assert.equal(result.note.body, input.body); assert.deepEqual(writes, ['POST', 'PUT']);
	assert.doesNotMatch(result.preview, /<img/); assert.match(result.preview, /<h1>Heading/);
	const same = await client.call('get_note', { id: result.note.id }); assert.equal(same.structuredContent.body, input.body);
	const page = await fetch(conf.origin+'/'); assert.ok(page.headers.get('content-security-policy').includes(`'sha256-${createHash('sha256').update(PREVIEW_STYLE).digest('base64')}'`)); await page.text();
	assert.match(client.stderr, /web: ready/); assert.doesNotMatch(client.stderr, new RegExp(conf.token+'|'+conf.webToken));
	await client.close(); assert.equal(client.child.exitCode, 0);
	await assert.rejects(fetch(conf.origin+'/api/status', { headers }));
});
test('actual entry rejects reuse of the broad core API token before opening a listener', async t => {
	const conf = await config(t, 'http://127.0.0.1:1', true);
	const child = spawn(process.execPath, [entry, conf.filename], { stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '', error = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => error += d);
	const [code] = await once(child, 'exit'); assert.equal(code, 1); assert.equal(output, ''); assert.match(error, /separate_web_token_required/); assert.ok(!error.includes(conf.token));
	await assert.rejects(fetch(conf.origin));
});
