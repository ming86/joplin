import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as client from '../clipper-extension/client.mjs';

// Execute the production popup controller with explicit fake DOM/Chrome APIs.
// This exercises state transitions, not extension loading or permission UI.
const folder = 'b'.repeat(32), token = 'x'.repeat(48);
async function popup(shared = {}) {
	shared.local ??= {}; shared.session ??= {}; shared.posts ??= [];
	const fields = new Map();
	class Element {
		value = ''; textContent = ''; disabled = false; hidden = false; listeners = {};
		addEventListener(type, fn) { this.listeners[type] = fn; }
		replaceChildren(...children) { this.value = children[0]?.value ?? ''; }
	}
	const el = id => { if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id); };
	const area = (name) => ({
		async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in shared[name]).map(k => [k, structuredClone(shared[name][k])])); },
		async set(values) { if (name === 'session' && values.pending && shared.failPending) throw new Error('session unavailable'); Object.assign(shared[name], structuredClone(values)); },
		async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete shared[name][key]; },
		async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); },
	});
	const dependencies = { ...client, async request(base, credential, route, input) {
		assert.equal(credential, token);
		if (route === 'v1/notebooks') return { items: [{ id: folder, title: 'Clips' }] };
		assert.deepEqual(shared.session.pending.input, input, 'retry record is stored before submitting');
		shared.posts.push({ base, input: structuredClone(input) });
		if (shared.failSend) throw new Error('response lost');
		return { noteId: 'c'.repeat(32), saved: 'local', replayed: shared.posts.length > 1 };
	} };
	const context = vm.createContext({
		dependencies, console,
		document: { getElementById: el }, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
		confirm: () => shared.discardApproved ?? false,
		chrome: {
			runtime: { id: 'a'.repeat(32) },
			permissions: { async request() { shared.permissionRequestDraft = structuredClone(shared.session.draft); if (shared.denyPermission) return false; shared.granted = true; return true; }, async contains() { return shared.granted ?? false; } },
			tabs: { async query() { return [{ id: 1, url: 'https://example.test/article' }]; } },
			scripting: { async executeScript() { shared.captureCount = (shared.captureCount ?? 0) + 1; return [{ result: shared.captures?.[shared.captureCount - 1] ?? { title: 'Captured title', text: 'Selected text 日本語', sourceUrl: 'https://example.test/article#part' } }]; } },
			storage: { local: area('local'), session: area('session') },
		},
	});
	const source = fs.readFileSync(new URL('../clipper-extension/popup.mjs', import.meta.url), 'utf8')
		.replace(/^import .*?;\n/, 'const { endpoint, permissionPattern, operation, request } = dependencies;\n')
		.replace('init().catch(e => say(e.message));', 'globalThis.ready = init().catch(e => say(e.message));');
	vm.runInContext(source, context, { filename: 'popup.mjs' });
	await context.ready;
	return {
		el,
		async click(id) { await el(id).listeners.click(); },
		async input(id, value) { el(id).value = value; await el(id).listeners.input(); },
		shared,
	};
}
async function connect(p) {
	p.el('endpoint').value = 'https://clip.example.test/'; p.el('token').value = token;
	await p.click('connect');
}
test('popup captures reviewed text; only endpoint preference is persisted in local storage', async () => {
	const p = await popup(); assert.equal(p.el('text').value, 'Selected text 日本語'); await connect(p);
	assert.deepEqual(p.shared.local, { endpoint: 'https://clip.example.test/' });
	assert.equal(p.shared.session.credential.token, token);
	await p.click('send'); assert.equal(p.shared.posts.length, 1); assert.equal(p.shared.session.pending, undefined); assert.equal(p.shared.session.draft, undefined);
	assert.match(p.el('status').textContent, /Saved locally/);
	assert.deepEqual(Object.keys(p.shared.local), ['endpoint']);
});
test('connected notebook survives popup closure and can be saved without reconnecting', async () => {
	const shared = {}; const a = await popup(shared); await connect(a);
	assert.equal(shared.session.draft.notebookId, folder);
	const b = await popup(shared); assert.equal(b.el('notebook').value, folder);
	await b.click('send'); assert.equal(shared.posts.length, 1);
});
test('lost response then popup reopen retries the identical stored operation', async () => {
	const shared = { failSend: true }; const a = await popup(shared); await connect(a); await a.click('send');
	const original = structuredClone(shared.posts[0]);
	assert.ok(shared.session.pending); const b = await popup(shared);
	for (const field of ['endpoint', 'notebook', 'title', 'source', 'text']) assert.equal(b.el(field).disabled, true);
	assert.equal(b.el('send').textContent, 'Retry same clip'); shared.failSend = false; await b.click('send');
	assert.deepEqual(shared.posts[1], original); assert.equal(shared.session.pending, undefined);
	assert.match(b.el('status').textContent, /Existing clip confirmed/);
});
test('failure to retain a pending operation prevents the network submission', async () => {
	const p = await popup({ failPending: true }); await connect(p); await p.click('send');
	assert.equal(p.shared.posts.length, 0); assert.equal(p.shared.session.pending, undefined);
	assert.match(p.el('status').textContent, /session unavailable/);
});
test('permission refusal preserves pending input and user can regrant without making a new operation', async () => {
	const shared = { failSend: true }; const a = await popup(shared); await connect(a); await a.click('send');
	const original = structuredClone(shared.session.pending); shared.granted = false; shared.denyPermission = true;
	const b = await popup(shared); await b.click('connect'); await b.click('send');
	assert.deepEqual(shared.session.pending, original); assert.equal(shared.posts.length, 1);
	shared.denyPermission = false; shared.failSend = false; await b.click('connect'); await b.click('send');
	assert.equal(shared.posts[1].input.operationId, original.input.operationId);
});
test('discarding pending state requires confirmation and does not send a delete', async () => {
	const shared = { failSend: true }; const p = await popup(shared); await connect(p); await p.click('send');
	await p.click('discard'); assert.ok(shared.session.pending); shared.discardApproved = true; await p.click('discard');
	assert.equal(shared.session.pending, undefined); assert.equal(shared.posts.length, 1);
	assert.equal(p.el('text').disabled, false);
});
test('edited draft survives popup closure and does not recapture a changed page', async () => {
	const shared = { captures: [
		{ title: 'Original page', text: 'Original selection', sourceUrl: 'https://example.test/first#selection' },
		{ title: 'Changed page', text: 'Changed selection', sourceUrl: 'https://example.test/second' },
	] };
	const a = await popup(shared);
	await a.input('endpoint', 'https://clip.example.test/'); await a.input('token', token);
	await a.input('title', 'Edited title'); await a.input('source', 'https://example.test/reviewed'); await a.input('text', 'Edited text');
	const b = await popup(shared);
	assert.equal(shared.captureCount, 1);
	assert.equal(b.el('endpoint').value, 'https://clip.example.test/'); assert.equal(b.el('token').value, token);
	assert.equal(b.el('title').value, 'Edited title'); assert.equal(b.el('source').value, 'https://example.test/reviewed'); assert.equal(b.el('text').value, 'Edited text');
});
test('permission prompt can close the popup after saving setup for the next popup', async () => {
	const shared = { denyPermission: true }; const a = await popup(shared);
	await a.input('endpoint', 'https://clip.example.test/'); await a.input('token', token); await a.input('title', 'Ready to resume');
	await a.click('connect');
	assert.deepEqual(shared.permissionRequestDraft, { endpoint: 'https://clip.example.test/', token, notebookId: '', title: 'Ready to resume', sourceUrl: 'https://example.test/article', text: 'Selected text 日本語' });
	const b = await popup(shared);
	assert.equal(b.el('endpoint').value, 'https://clip.example.test/'); assert.equal(b.el('token').value, token); assert.equal(b.el('title').value, 'Ready to resume');
});
test('pending retry takes priority over a different draft', async () => {
	const shared = { failSend: true }; const a = await popup(shared); await connect(a); await a.click('send');
	shared.session.draft = { endpoint: 'https://other.example.test/', token: 'other token', notebookId: folder, title: 'Different draft', sourceUrl: 'https://example.test/other', text: 'Different text' };
	const b = await popup(shared);
	assert.equal(b.el('endpoint').value, shared.session.pending.endpoint); assert.equal(b.el('title').value, shared.session.pending.input.title);
	assert.equal(b.el('text').value, shared.session.pending.input.text); assert.equal(b.el('send').textContent, 'Retry same clip');
	await b.input('token', 'y'.repeat(48)); const c = await popup(shared);
	assert.equal(c.el('token').value, 'y'.repeat(48)); assert.equal(c.el('title').value, shared.session.pending.input.title);
});
