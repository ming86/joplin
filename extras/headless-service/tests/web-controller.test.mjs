import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Draft } from '../web/draft.mjs';
import { previewDocument } from '../web/preview.mjs';
import { note, folderId } from './fixtures.mjs';

// Production controller, explicit fake DOM/fetch. These are NOT browser,
// installability, CSP-enforcement or native Joplin acceptance tests.
async function controller(shared = {}) {
	shared.calls ??= []; shared.current ??= { note: { ...note, body: 'one\r\ntwo\r\n' }, version: 'a'.repeat(64), editable: true, preview: '<p>one</p>' };
	const fields = new Map(), events = {};
	class Element {
		value = ''; textContent = ''; disabled = false; readOnly = false; hidden = false; children = []; listeners = {}; dataset = {};
		addEventListener(name, fn) { this.listeners[name] = fn; }
		replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; }
		append(...children) { this.children.push(...children); }
		get options() { return this.children; }
		setAttribute() {} focus() {}
	}
	const el = id => { if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id); };
	el('mode').value = 'keyword'; el('notebook').replaceChildren({ value: '', textContent: 'All notebooks' });
	const fetch = async (url, options) => {
		const input = options.body ? JSON.parse(options.body) : undefined;
		shared.calls.push({ url, method: options.method, input });
		const result = (status, value) => ({ ok: status === 200, status, json: async () => structuredClone(value) });
		if (url === '/api/login') { shared.signedIn = true; return result(200, { authenticated: true }); }
		if (url === '/api/logout') { shared.signedIn = false; return result(200, { authenticated: false }); }
		if (shared.signedIn === false) return result(401, { error: 'authentication_required' });
		if (shared.intercept) { const r = await shared.intercept(url, input); if (r) return r; }
		if (url === '/api/status') return result(200, {
			core: 'reachable', allowWrites: true, semantic: { state: 'unavailable' },
			sync: { running: false, pending: false, kind: null, lastPeriodicFullSync: null },
		});
		if (url.startsWith('/api/notebooks')) return result(200, { items: [{ id: folderId, title: 'Personal' }], hasMore: false });
		if (url.startsWith('/api/notes')) return result(200, { items: [shared.current.note], hasMore: false });
		if (url.startsWith('/api/note/')) return result(200, shared.current);
		if (url === '/api/search') return result(200, { items: [], semantic: { state: 'unavailable' }, executedMode: 'keyword', hasMore: false });
		if (url === '/api/write') {
			if (shared.failWrite === 'unknown') throw new Error('Synthetic response loss');
			if (shared.failWrite) return result(409, { error: shared.failWrite });
			shared.current = { ...shared.current, note: { ...shared.current.note, title: input.title, body: input.body }, version: 'b'.repeat(64), reconciled: true };
			return result(200, shared.current);
		}
		if (url === '/api/preview') return result(200, { preview: '<p>Preview</p>' });
		throw new Error('Unexpected test request');
	};
	const context = vm.createContext({
		Draft, previewDocument, fetch, AbortSignal, structuredClone, console,
		document: { getElementById: el, createElement: () => new Element(), hidden: false },
		Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
		window: { addEventListener(name, fn) { events[name] = fn; } },
		navigator: { onLine: true, clipboard: { async writeText(text) { shared.clipboard = text; } } },
		confirm: message => { shared.confirmation = message; return shared.confirmed ?? false; },
		setInterval: () => {},
	});
	const source = fs.readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
	const api = await vm.runInContext(`(async () => {${source}\nreturn { loadNote, notes, draft, current: () => ({ search, latest, authenticated }) };})()`, context, { filename: 'app.mjs' });
	return { el, events, shared, ...api,
		async click(id) { await el(id).listeners.click({ preventDefault() {} }); },
		async submit(id) { await el(id).listeners.submit({ preventDefault() {} }); },
		async input(id, value) { el(id).value = value; await el(id).listeners.input(); },
	};
}
test('web controller signs in, clears typed key and renders response content inertly', async () => {
	const c = await controller({ signedIn: false });
	assert.equal(c.el('workspace').hidden, true);
	c.el('access-key').value = 'synthetic-web-key'; await c.submit('login-form');
	assert.equal(c.el('access-key').value, ''); assert.equal(c.el('workspace').hidden, false);
	await c.loadNote(note.id); assert.equal(c.el('body').value, 'one\r\ntwo\r\n');
	assert.match(c.el('preview').srcdoc, /default-src 'none'/); assert.equal(c.el('connection').textContent, 'Client reachable');
});
test('title-only edit preserves exact CRLF body through production controller save', async () => {
	const c = await controller(); await c.loadNote(note.id);
	c.el('body').value = 'one\ntwo\n'; // A real textarea normalizes this property.
	await c.input('title', 'Changed title'); await c.click('save');
	const write = c.shared.calls.find(r => r.url === '/api/write');
	assert.equal(write.input.body, 'one\r\ntwo\r\n'); assert.equal(c.draft.pending, null);
	assert.match(c.el('save-status').textContent, /confirmed locally/);
});
test('unknown save locks fields, retries exactly, and explicit discard never deletes a note', async () => {
	const c = await controller({ failWrite: 'unknown' }); await c.click('new-note');
	await c.input('title', 'Uncertain capture'); await c.input('body', '**text** 笔记'); await c.click('save');
	const original = structuredClone(c.draft.pending);
	assert.equal(c.el('title').readOnly, true); assert.equal(c.el('discard').disabled, false);
	await c.input('title', 'must not replace pending'); await c.click('save');
	assert.deepEqual(c.shared.calls.filter(r => r.url === '/api/write').map(r => r.input), [original, original]);
	await c.click('discard'); assert.ok(c.draft.pending); assert.match(c.shared.confirmation, /does not delete any note/);
	c.shared.confirmed = true; await c.click('discard');
	assert.equal(c.draft.value, null); assert.equal(c.el('body').value, ''); assert.equal(c.el('logout').disabled, false);
	assert.equal(c.shared.calls.filter(r => r.method === 'DELETE').length, 0);
});
test('stale write keeps editable draft and requires explicit compare/rebase before a new save', async () => {
	const c = await controller({ failWrite: 'stale_note' }); await c.loadNote(note.id); await c.input('body', 'My edit'); await c.click('save');
	assert.equal(c.el('body').readOnly, false); assert.equal(c.draft.pending, null);
	c.shared.current = { ...c.shared.current, version: 'c'.repeat(64), note: { ...c.shared.current.note, body: 'Stock edit' } };
	await c.click('compare'); await c.click('rebase'); assert.equal(c.draft.value.baseVersion, 'a'.repeat(64));
	c.shared.confirmed = true; await c.click('rebase'); assert.equal(c.draft.value.body, 'My edit'); assert.equal(c.draft.value.baseVersion, 'c'.repeat(64));
	assert.equal(c.shared.calls.filter(r => r.url === '/api/write').length, 1);
});
test('successful logout clears note, comparison and query text', async () => {
	const c = await controller(); await c.loadNote(note.id); await c.click('compare');
	c.el('query').value = 'private search'; await c.submit('search-form');
	await c.click('logout');
	for (const id of ['title', 'body', 'query']) assert.equal(c.el(id).value, '');
	for (const id of ['latest-title', 'latest-body', 'search-status', 'service-status', 'save-status']) assert.equal(c.el(id).textContent, '');
	assert.equal(c.current().search, null); assert.equal(c.current().latest, null); assert.equal(c.draft.value, null);
	assert.equal(c.el('workspace').hidden, true);
});
test('beforeunload warning appears for dirty or pending drafts, not clean reads', async () => {
	const c = await controller(); await c.loadNote(note.id); let prevented = false;
	const event = () => ({ preventDefault() { prevented = true; }, returnValue: undefined });
	c.events.beforeunload(event()); assert.equal(prevented, false);
	await c.input('body', 'changed'); c.events.beforeunload(event()); assert.equal(prevented, true);
});
test('old preview response cannot replace a newer selected note', async () => {
	const c = await controller(); await c.loadNote(note.id);
	let finish; c.shared.intercept = url => url === '/api/preview' ? new Promise(resolve => { finish = resolve; }) : undefined;
	const request = c.click('preview-button'); await new Promise(resolve => setImmediate(resolve));
	c.shared.current = { ...c.shared.current, note: { ...c.shared.current.note, id: 'f'.repeat(32) }, preview: '<p>New note</p>' };
	await c.loadNote('f'.repeat(32)); finish({ ok: true, status: 200, json: async () => ({ preview: '<p>Old note</p>' }) }); await request;
	assert.match(c.el('preview').srcdoc, /New note/); assert.doesNotMatch(c.el('preview').srcdoc, /Old note/);
});

test('late note-list response after logout does not restore private titles', async () => {
	const c = await controller(); let finish;
	c.shared.intercept = url => url.startsWith('/api/notes') ? new Promise(resolve => { finish = resolve; }) : undefined;
	const pending = c.notes(); await new Promise(resolve => setImmediate(resolve)); await c.click('logout');
	finish({ ok: true, status: 200, json: async () => ({ items: [note], hasMore: false }) }); await pending;
	assert.equal(c.el('notes').children.length, 0); assert.equal(c.el('search-status').textContent, '');
});
