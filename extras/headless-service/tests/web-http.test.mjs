import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startWebServer, webOrigin } from '../src/web/http.mjs';
import { loadWebConfig } from '../src/web/config.mjs';
import { webFixture, newWrite } from './web-fixtures.mjs';
import { noteId } from './fixtures.mjs';
const token = 'synthetic_web_key_'.repeat(3);
async function setup(t, opts = {}) {
	const f = webFixture(opts);
	const web = await startWebServer({ service: f.service, token, ...opts });
	t.after(() => web.close()); let cookie = '';
	async function call(route, data, extra = {}) {
		// Raw HTTP is deliberate: fetch can ignore/replace forbidden Host headers.
		return new Promise((resolve, reject) => {
			const req = http.request(web.baseUrl + route, { method: data === undefined ? 'GET' : 'POST', ...extra, headers: { 'X-Joplin-Web': '1', Origin: web.origin, ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra.headers } }, res => {
				const parts=[]; res.on('data', b=>parts.push(b)); res.on('end', ()=>resolve(new Response(Buffer.concat(parts), { status: res.statusCode, headers: res.headers })));
			}); req.once('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
		});
	}
	async function login() { const response = await call('/api/login', { token }); assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; await response.json(); return response; }
	return { ...f, web, call, login, cookie: () => cookie };
}
test('all note APIs require authentication; session cookie is HttpOnly and token never returned', async t => {
	const f = await setup(t);
	for (const route of ['/api/status', '/api/notes', `/api/note/${noteId}`]) { const r = await f.call(route); assert.equal(r.status, 401); await r.text(); }
	const login = await f.login(); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/); assert.ok(!login.headers.get('set-cookie').includes(token));
	const note = await f.call(`/api/note/${noteId}`); assert.equal(note.status, 200); assert.equal(note.headers.get('cache-control'), 'no-store');
	assert.ok(!(await note.text()).includes(token));
	await (await f.call('/api/logout', {})).text(); const after = await f.call('/api/status'); assert.equal(after.status, 401); await after.text();
});
test('exact Host and Origin plus custom header reject cross-origin reads/writes and forged proxy identity', async t => {
	const f = await setup(t); await f.login();
	for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'X-Joplin-Web': '' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null' }]) {
		const r = await f.call('/api/write', newWrite(), { headers }); assert.equal(r.status, 403); await r.text();
	}
	const missingOrigin = await fetch(f.web.baseUrl+'/api/write', { method: 'POST', headers: { Cookie: f.cookie(), 'Content-Type': 'application/json', 'X-Joplin-Web': '1', 'X-Forwarded-Host': new URL(f.web.origin).host }, body: JSON.stringify(newWrite()) });
	assert.equal(missingOrigin.status, 403); await missingOrigin.text(); assert.equal(f.writes.length, 0);
	const cors = await fetch(f.web.baseUrl+'/api/write', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Headers': 'x-joplin-web' } });
	assert.equal(cors.headers.get('access-control-allow-origin'), null); await cors.text();
});
test('HTTPS deployment sets host-only Secure cookie and refuses non-loopback HTTP configuration', async t => {
	const f = await setup(t, { publicOrigin: 'https://notes.example.test' });
	const r = await f.call('/api/login', { token }, { headers: { Host: 'notes.example.test' } });
	assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /^__Host-joplin_web=/); assert.match(r.headers.get('set-cookie'), /; Secure/); assert.ok(!r.headers.get('set-cookie').includes('Domain=')); await r.text();
	for (const invalid of ['http://192.168.1.2', 'https://notes.example.test/path', 'https://user:pw@host/', 'https://host/?token=x']) assert.throws(() => webOrigin(invalid));
});
test('expired sessions and duplicate session cookies are rejected', async t => {
	let time = 100000;
	const f = await setup(t, { now: () => time, sessionMs: 1000 }); await f.login();
	const duplicate = await f.call('/api/status', undefined, { headers: { Cookie: f.cookie()+'; '+f.cookie() } }); assert.equal(duplicate.status, 401); await duplicate.text();
	time += 1001;
	const expired = await f.call('/api/status'); assert.equal(expired.status, 401); await expired.text();
});
test('login brute-force requests are bounded without backend calls', async t => {
	const f = await setup(t);
	for (let i=0; i<10; i++) { const r = await f.call('/api/login', { token: 'wrong' }); assert.equal(r.status, 401); await r.text(); }
	const limited = await f.call('/api/login', { token: 'wrong' }); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60'); await limited.text();
	assert.equal(f.writes.length, 0);
});
test('static allowlist, no arbitrary routes, no credential query parameters, CSP, manifest and icons', async t => {
	const f = await setup(t); await f.login();
	for (const route of ['/', '/app.mjs', '/draft.mjs', '/preview.mjs', '/app.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']) {
		const r = await fetch(f.web.baseUrl+route); assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(r.headers.get('referrer-policy'), 'no-referrer'); await r.arrayBuffer();
	}
	for (const route of ['/api/notes?accountId=bob', '/api/notes?page=1&page=2', '/api/notes?token=secret', '/api/notes?page=0', '/api/notes?limit=101', '/api/status?extra=1', '/src/web/config.mjs', '/api/../src/joplin.mjs', '/api/note/not-an-id']) {
		const r = await f.call(route); assert.ok(r.status >= 400, route); await r.text();
	}
	const response = await fetch(f.web.baseUrl+'/manifest.webmanifest'); const m = await response.json(); assert.deepEqual(m.icons.map(i => i.sizes), ['192x192','512x512']); assert.equal(m.display,'standalone');
});
test('real HTTP writes, error contracts and search results exclude full note bodies', async t => {
	const f = await setup(t); await f.login();
	let r = await f.call('/api/write', newWrite()); assert.equal(r.status, 200); const saved = await r.json(); assert.equal(saved.note.body, newWrite().body);
	r = await f.call('/api/write', newWrite()); assert.equal((await r.json()).reconciled, true);
	r = await f.call('/api/search', { query: 'Browser', mode: 'hybrid' }); const result = await r.json(); assert.equal(result.executedMode, 'keyword'); assert.equal(result.semantic.state, 'unavailable'); assert.equal(result.items[0].body, undefined);
	r = await f.call('/api/search', { query: 'Browser', mode: 'semantic' }); assert.equal((await r.json()).executedMode, null);
	r = await f.call('/api/write', { ...newWrite(), accountId: 'bob' }); assert.equal(r.status, 400); await r.text();
	r = await f.call('/api/write', { ...newWrite(), body: 'different' }); assert.equal(r.status, 409); await r.text();
	r = await f.call('/api/write', newWrite(), { headers: { 'Content-Type': 'text/plain' } }); assert.equal(r.status, 415); await r.text();
});
test('semantic/hybrid browser query uses the same bound engine and reports its mode', async t => {
	const f = await setup(t, { makeSemanticBackend: c => ({ accountId: c.id, status: () => ({ state: 'ready' }), search: async input => ({ accountId: c.id, requestedMode: input.mode, executedMode: input.mode, semantic: { state: 'ready' }, items: [], hasMore: false }) }) });
	await f.login(); const r = await f.call('/api/search', { query: 'meaning', mode: 'hybrid' }); assert.equal((await r.json()).executedMode, 'hybrid');
});
test('read-only mode hides write permission and rejects a manually forged write', async t => {
	const f = await setup(t, { allowWrites: false }); await f.login();
	const r = await f.call('/api/write', newWrite()); assert.equal(r.status, 403); await r.text();
	const status = await (await f.call('/api/status')).json(); assert.equal(status.allowWrites, false);
});
test('web configuration uses private key files and rejects unknown fields', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-config-test-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
	const key = path.join(dir,'key'), filename = path.join(dir,'web.json'); fs.writeFileSync(key,token,{mode:0o600});
	const c = { accountConfigFile: path.join(dir,'account.json'), webTokenFile:key, namespace:'f'.repeat(32), port:4120, publicOrigin:'http://127.0.0.1:4120' };
	fs.writeFileSync(filename,JSON.stringify(c)); assert.equal(loadWebConfig(filename).token,token);
	fs.chmodSync(key,0o644); assert.throws(()=>loadWebConfig(filename), e=>e.code==='private_token_permissions_required'); fs.chmodSync(key,0o600);
	fs.writeFileSync(filename,JSON.stringify({...c,apiToken:'not allowed'})); assert.throws(()=>loadWebConfig(filename));
});
