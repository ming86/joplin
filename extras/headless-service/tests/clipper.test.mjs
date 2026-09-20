import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServiceError } from '../src/errors.mjs';
import { createClipService, clipInput, literalMarkdown } from '../src/clipper/service.mjs';
import { startClipServer } from '../src/clipper/http.mjs';
import { loadClipConfig } from '../src/clipper/config.mjs';
import { createJoplinClient } from '../src/joplin.mjs';
import { endpoint, permissionPattern, operation, request } from '../clipper-extension/client.mjs';
import { server, readJson } from './fixtures.mjs';
const folder = 'b'.repeat(32), op = 'd'.repeat(32), token = 'x'.repeat(48);
const input = () => ({ operationId: op, notebookId: folder, title: 'Selected text', text: 'Hello 笔记', sourceUrl: 'https://example.test/page#section' });
function setup(options = {}) {
	const records = new Map(); let writes = 0; let failure;
	const backend = {
		async getNotebook(id) { if (id !== folder) throw new ServiceError('not_found'); return { id, title: 'Allowed' }; },
		async getClipRecord(id) { if (!records.has(id)) throw new ServiceError('not_found'); return { ...records.get(id) }; },
		async createClipRecord(n) { writes++; if (failure === 'before') throw new Error('secret payload must never leak'); if (records.has(n.id)) throw new ServiceError('backend_request_failed'); records.set(n.id, { ...n, deleted_time: 0, is_locked: 0, encryption_applied: 0 }); if (failure === 'after') throw new ServiceError('write_outcome_unknown', true); return { id: n.id }; },
	};
	const config = { accountId: 'alice', namespace: 'c'.repeat(32), notebookIds: [folder], backend, ...options };
	return { config, records, backend, service: createClipService(config), writes: () => writes, fail: value => { failure = value; } };
}
test('stable receipt survives service restart and preserves subsequent note edits', async () => {
	const s = setup(); const first = await s.service.submit(input());
	assert.equal(first.saved, 'local'); assert.equal(first.synchronization, 'not_confirmed');
	const record = s.records.get(first.noteId); record.body = 'An edited note';
	const second = await createClipService(s.config).submit(input());
	assert.equal(second.noteId, first.noteId); assert.equal(second.replayed, true); assert.equal(s.writes(), 1); assert.equal(record.body, 'An edited note');
	assert.deepEqual(await s.service.notebooks(), { items: [{ id: folder, title: 'Allowed' }] });
});
test('parallel identical requests coalesce; operation ID cannot silently change payload', async () => {
	const s = setup(); const results = await Promise.all(Array.from({ length: 5 }, () => s.service.submit(input())));
	assert.equal(new Set(results.map(r => r.noteId)).size, 1); assert.equal(s.writes(), 1);
	await assert.rejects(s.service.submit({ ...input(), text: 'different' }), { code: 'clip_operation_conflict' });
	const fresh = setup(); const first = fresh.service.submit(input());
	await assert.rejects(fresh.service.submit({ ...input(), title: 'different' }), { code: 'clip_operation_conflict' }); await first;
});
test('lost backend response reconciles a committed receipt; uncommitted failure remains unknown', async () => {
	const s = setup(); s.fail('after'); const result = await s.service.submit(input());
	assert.equal(result.replayed, true); assert.equal(s.records.size, 1);
	const next = setup(); next.fail('before'); await assert.rejects(next.service.submit(input()), { code: 'clip_outcome_unknown', outcomeUnknown: true });
	next.fail(null); await next.service.submit(input()); assert.equal(next.records.size, 1);
});
test('receipts in trash, moved, encrypted, locked or replaced are conflicts, never overwritten', async () => {
	for (const changes of [{ deleted_time: 1 }, { parent_id: 'a'.repeat(32) }, { encryption_applied: 1 }, { is_locked: 1 }, { source: 'other' }]) {
		const s = setup(); const r = await s.service.submit(input()); Object.assign(s.records.get(r.noteId), changes);
		await assert.rejects(s.service.submit(input()), { code: 'clip_operation_conflict' }); assert.equal(s.writes(), 1);
	}
});
test('account and stable namespace separate identities; unauthorized destinations rejected before writing', async () => {
	const a = setup(), b = setup({ accountId: 'bob' }), c = setup({ namespace: 'e'.repeat(32) });
	const ids = await Promise.all([a,b,c].map(async s => (await s.service.submit(input())).noteId)); assert.equal(new Set(ids).size, 3);
	await assert.rejects(a.service.submit({ ...input(), notebookId: 'f'.repeat(32) }), { code: 'clip_notebook_not_permitted' }); assert.equal(a.writes(), 1);
});
test('clip input bounds, literal markup and source restrictions', () => {
	for (const extra of [{ accountId: 'bob' }, { body: 'markdown' }, { html: '<img>' }, { text: '' }, { text: 'x'.repeat(131073) }, { text: '\ud800' }, { title: 'line\nbreak' }, { sourceUrl: 'file:///tmp/private' }, { sourceUrl: 'https://user:secret@example.test' }]) assert.throws(() => clipInput({ ...input(), ...extra }));
	assert.equal(clipInput(input()).sourceUrl, 'https://example.test/page');
	const escaped = literalMarkdown('![x](file:///private) <img src="https://evil"> & &#33;');
	assert.ok(!escaped.includes('![')); assert.ok(!escaped.includes('<img')); assert.ok(escaped.includes('&amp;'));
});
test('private API clip adapter preserves explicit ID/source and does not expose raw token or unknown properties', async t => {
	const calls = [];
	const url = await server(t, async (req, res) => {
		const u = new URL(req.url, 'http://localhost'); assert.equal(u.searchParams.get('token'), 'private'); calls.push(u.pathname);
		res.setHeader('Content-Type', 'application/json');
		if (u.pathname === '/notes' && req.method === 'POST') { const body = await readJson(req); assert.equal(body.id, op); assert.equal(body.source, 'joplin-headless-clip/v1:' + 'a'.repeat(64)); assert.equal(body.user_data, undefined); res.end(JSON.stringify({ id: op, unexpected: 'hidden' })); }
		else if (u.pathname === `/notes/${op}`) { assert.equal(u.searchParams.get('include_deleted'), '1'); assert.ok(!u.searchParams.get('fields').includes('body')); res.end(JSON.stringify({ id: op, parent_id: folder, source: 'receipt', body: 'hidden', encryption_applied: 0 })); }
		else res.end(JSON.stringify({ id: folder, title: 'Allowed', deleted_time: 0 }));
	});
	const api = createJoplinClient({ baseUrl: url, token: 'private' });
	assert.deepEqual(await api.createClipRecord({ id: op, parent_id: folder, title: 'a', body: 'text', source: 'joplin-headless-clip/v1:' + 'a'.repeat(64) }), { id: op });
	assert.equal((await api.getClipRecord(op)).body, undefined); assert.equal((await api.getNotebook(folder)).title, 'Allowed'); assert.equal(calls.length, 3);
});
test('HTTP bearer, Host, Origin, CORS and restricted route policy', async t => {
	const s = setup(); const origin = 'chrome-extension://' + 'a'.repeat(32);
	const app = await startClipServer({ service: s.service, token, allowedOrigins: [origin] }); t.after(() => app.close());
	async function call(route, options = {}) { const res = await fetch(app.baseUrl + route, options); const text = await res.text(); return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null }; }
	assert.equal((await call('/v1/notebooks')).status, 401);
	assert.equal((await call('/v1/notebooks', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.test' } })).status, 403);
	const hostStatus = await new Promise((resolve, reject) => { const q = http.get(app.baseUrl + '/v1/notebooks', { headers: { Authorization: `Bearer ${token}`, Host: 'evil.test' } }, r => { r.resume(); resolve(r.statusCode); }); q.on('error', reject); });
	assert.equal(hostStatus, 403);
	assert.equal((await call('/notes', { headers: { Authorization: `Bearer ${token}` } })).status, 404);
	const pre = await call('/v1/clips', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
	assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), origin);
	const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
	assert.equal((await call('/v1/notebooks', { headers })).data.items.length, 1);
	assert.equal((await call('/v1/clips', { method: 'POST', headers, body: JSON.stringify(input()) })).status, 201);
	const replay = await call('/v1/clips', { method: 'POST', headers, body: JSON.stringify(input()) }); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.headers.get('cache-control'), 'no-store');
	assert.equal((await call('/v1/clips', { method: 'POST', headers, body: '{' })).status, 400);
	assert.equal((await call('/v1/clips', { method: 'POST', headers, body: JSON.stringify({ ...input(), accountId: 'bob' }) })).status, 400);
	assert.equal((await call('/v1/clips', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'text' })).status, 415);
	assert.equal((await call('/v1/clips', { method: 'POST', headers, body: 'x'.repeat(1024*1024+1) })).status, 413);
});
test('authenticated request budget is bounded and shutdown closes listeners', async () => {
	const app = await startClipServer({ service: setup().service, token, requestsPerMinute: 1 });
	const headers = { Authorization: `Bearer ${token}` };
	assert.equal((await fetch(app.baseUrl+'/v1/notebooks', { headers })).status, 200);
	const res = await fetch(app.baseUrl+'/v1/notebooks', { headers }); assert.equal(res.status, 429); assert.equal(res.headers.get('retry-after'), '60'); await res.text();
	await app.close(); await app.close(); await assert.rejects(fetch(app.baseUrl+'/v1/notebooks'));
});
test('clip configuration requires a separate private token, fixed destinations and known fields', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-config-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const api = path.join(dir, 'api'), clip = path.join(dir, 'clip'), file = path.join(dir, 'config');
	fs.writeFileSync(api, 'y'.repeat(48), { mode: 0o600 }); fs.writeFileSync(clip, token, { mode: 0o600 });
	const c = { accountId: 'alice', baseUrl: 'http://127.0.0.1:41184', apiTokenFile: api, clipTokenFile: clip, namespace: op, notebookIds: [folder], port: 41190 };
	fs.writeFileSync(file, JSON.stringify(c)); assert.equal(loadClipConfig(file).token, token);
	fs.writeFileSync(clip, 'y'.repeat(48)); assert.throws(() => loadClipConfig(file), { code: 'separate_clip_token_required' });
	fs.writeFileSync(clip, token); fs.chmodSync(clip, 0o644); assert.throws(() => loadClipConfig(file));
	fs.chmodSync(clip, 0o600); fs.writeFileSync(file, JSON.stringify({ ...c, arbitrary: true })); assert.throws(() => loadClipConfig(file));
});
test('browser client binds immutable operation fields and uses no cookies or automatic redirects', async () => {
	for (const url of ['http://remote.test', 'https://user:secret@remote.test', 'https://remote.test/?token=abc', 'file:///tmp']) assert.throws(() => endpoint(url));
	assert.equal(endpoint('https://remote.test/clipper'), 'https://remote.test/clipper/');
	assert.equal(permissionPattern('http://127.0.0.1:41190'), 'http://127.0.0.1/*');
	assert.equal(permissionPattern('https://remote.test:8443/clipper/'), 'https://remote.test/*');
	const value = operation(input(), op); assert.equal(value.operationId, op); assert.equal(value.sourceUrl, 'https://example.test/page');
	let sent;
	const result = await request('https://remote.test/clipper/', token, 'v1/clips', value, async (url, opts) => {
		sent = JSON.parse(opts.body); assert.equal(opts.credentials, 'omit'); assert.equal(opts.redirect, 'error'); assert.equal(url.pathname, '/clipper/v1/clips');
		return new Response(JSON.stringify({ noteId: op, saved: 'local' }), { status: 201 });
	}); assert.deepEqual(sent, value); assert.equal(result.noteId, op);
	await assert.rejects(request('https://remote.test/', token, 'v1/clips', value, async () => new Response('failure', { status: 503 })));
});

test('a failed verification read after an ambiguous create still reports outcome unknown', async () => {
	const s = setup();
	let attempted = false;
	const oldRead = s.backend.getClipRecord;
	s.backend.getClipRecord = async (...args) => {
		if (attempted) throw new ServiceError('backend_unavailable');
		return oldRead(...args);
	};
	s.backend.createClipRecord = async () => { attempted = true; throw new ServiceError('write_outcome_unknown', true); };
	await assert.rejects(s.service.submit(input()), { code: 'clip_outcome_unknown', outcomeUnknown: true });
});
