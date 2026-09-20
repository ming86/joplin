import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError, createAccountRegistry } from '../index.mjs';
import { createWebService, noteVersion, MAX_BODY_BYTES } from '../src/web/service.mjs';
import { Draft } from '../web/draft.mjs';
import { webFixture, newWrite, namespace, realRender } from './web-fixtures.mjs';
import { account, note, noteId, folderId, server, readJson } from './fixtures.mjs';
import { createJoplinClient } from '../src/joplin.mjs';
const code = value => e => e.code === value;
const update = (base, body = 'changed') => ({ kind: 'update', operationId: 'e'.repeat(32), noteId, baseVersion: base.version, title: 'Updated', body });

test('web reads metadata without bodies and preserves exact supported Markdown on save', async () => {
	const f = webFixture(), loaded = await f.service.get(noteId);
	assert.equal((await f.service.notes()).items[0].body, undefined);
	const body = '# 日本語\r\n\r\n![x](file:///etc/hostname)\r\n<img src="http://localhost/x">\r\n\n```js\nconst x = "&<>";\n```\n';
	const saved = await f.service.write(update(loaded, body));
	assert.equal(saved.note.body, body); assert.equal(saved.saved, 'local'); assert.equal(saved.synchronization, 'not_observed');
	assert.equal(f.writes.length, 1); assert.equal(f.writes[0].method, 'PUT');
});
test('new Markdown is never sent to POST; blank receipt survives restart and lost reply', async () => {
	const f = webFixture(), input = newWrite('![x](http://127.0.0.1:1/secret)');
	f.hooks.afterPlaceholder = async () => { throw new ServiceError('write_outcome_unknown', true); };
	await assert.rejects(f.service.write(input), code('write_outcome_unknown'));
	assert.equal(f.notes.size, 2); assert.equal(f.writes.length, 1);
	assert.ok(!JSON.stringify(f.writes[0]).includes(input.body));
	f.hooks.afterPlaceholder = null;
	const next = f.restart(), saved = await next.write(input);
	assert.equal(saved.note.body, input.body); assert.equal(f.notes.size, 2);
	const count = f.writes.length, replay = await f.restart().write(input);
	assert.equal(replay.note.id, saved.note.id); assert.equal(replay.reconciled, true); assert.equal(f.writes.length, count);
	await assert.rejects(next.write({ ...input, body: 'different retry' }), code('web_creation_conflict'));
	f.notes.get(saved.note.id).deleted_time = 1;
	await assert.rejects(next.write(input), code('web_creation_conflict'));
});
test('edited placeholders are not overwritten by retries; missing notebook rejected before write', async () => {
	const f = webFixture(); f.hooks.afterPlaceholder = async n => { n.body = 'Another client changed this'; throw new ServiceError('write_outcome_unknown', true); };
	await assert.rejects(f.service.write(newWrite()));
	await assert.rejects(f.restart().write(newWrite()), code('web_creation_conflict'));
	assert.equal(f.writes.filter(w => w.method === 'PUT').length, 0);
	const g = webFixture(); await assert.rejects(g.service.write({ ...newWrite(), notebookId: 'f'.repeat(32) }), code('not_found')); assert.equal(g.writes.length, 0);
});
test('lost update response reconciles readable content without a second write', async () => {
	const f = webFixture(), loaded = await f.service.get(noteId), input = update(loaded);
	f.hooks.afterUpdate = async () => { throw new ServiceError('write_outcome_unknown', true); };
	await assert.rejects(f.service.write(input), code('write_outcome_unknown'));
	const result = await f.restart().write(input);
	assert.equal(result.reconciled, true); assert.equal(f.writes.length, 1);
});
test('stale preflight rejects an observed stock-style edit and retains server content', async () => {
	const f = webFixture(), loaded = await f.service.get(noteId);
	f.notes.get(noteId).body = 'Stock edit'; f.notes.get(noteId).updated_time++;
	await assert.rejects(f.service.write(update(loaded)), code('stale_note'));
	assert.equal(f.notes.get(noteId).body, 'Stock edit'); assert.equal(f.writes.length, 0);
});
test('preflight is not atomic: a change after it can be overwritten (documented limit)', async () => {
	const f = webFixture(), input = update(await f.service.get(noteId));
	f.hooks.beforeUpdate = async () => { f.notes.get(noteId).body = 'Racing stock edit'; };
	await f.service.write(input); assert.equal(f.notes.get(noteId).body, input.body);
});
test('gateway serializes simultaneous edits of one note; second stale write fails', async () => {
	const f = webFixture(), loaded = await f.service.get(noteId);
	const result = await Promise.allSettled([f.service.write(update(loaded, 'first')), f.service.write(update(loaded, 'second'))]);
	assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].reason.code, 'stale_note'); assert.equal(f.writes.length, 1);
});
test('locked, encrypted, deleted, HTML and oversize notes cannot be silently overwritten', async () => {
	for (const props of [{ is_locked: 1 }, { encryption_applied: 1 }, { deleted_time: 1 }]) {
		const f = webFixture({ records: [{ ...note, ...props }] });
		await assert.rejects(f.service.get(noteId), code('note_unavailable'));
		assert.equal((await f.service.notes()).items.length, 0);
	}
	for (const props of [{ markup_language: 2 }, { body: 'x'.repeat(MAX_BODY_BYTES + 1) }]) {
		const f = webFixture({ records: [{ ...note, ...props }] }), read = await f.service.get(noteId);
		assert.equal(read.editable, false); await assert.rejects(f.service.write(update(read)), code('unsupported_note_format')); assert.equal(f.writes.length, 0);
	}
});
test('read-only principal blocks web-only operations before invoking the backend', async () => {
	const f = webFixture({ allowWrites: false });
	await assert.rejects(f.service.write(newWrite()), code('operation_not_permitted'));
	await assert.rejects(f.account.createWebPlaceholder({}), code('operation_not_permitted'));
	await assert.rejects(f.account.getWebCreationRecord(noteId), code('operation_not_permitted'));
	assert.equal(f.writes.length, 0);
});
test('different account bindings with identical IDs never select one another from request fields', async () => {
	const a = webFixture(), b = webFixture({ records: [{ ...note, body: 'Bob' }] });
	const ac = account(), bc = account('bob');
	const registry = createAccountRegistry([ac, bc], { makeBackend: c => c.id === 'alice' ? a.backend : b.backend });
	const sa = createWebService({ account: registry.forPrincipal('alice', 'alice'), namespace, allowWrites: true, render: x => x });
	const sb = createWebService({ account: registry.forPrincipal('bob', 'bob'), namespace, allowWrites: true, render: x => x });
	assert.notEqual((await sa.get(noteId)).note.body, (await sb.get(noteId)).note.body);
	await assert.rejects(sa.write({ ...newWrite(), accountId: 'bob' }), code('invalid_web_write'));
	assert.throws(() => registry.forPrincipal('alice', 'bob'), code('account_not_available'));
});
test('renderer reuses real markdown-it: raw HTML escaped, images inert, safe links inert, tables preserved', () => {
	const render = realRender();
	const html = render('# Heading\n\n<script>alert(1)</script>\n\n![photo](file:///etc/passwd)\n\n![photo](https://example.test/x)\n\n[go](https://example.test)\n\n|a|b|\n|-|-|\n|1|2|');
	assert.ok(html.includes('<h1>Heading</h1>')); assert.ok(html.includes('&lt;script&gt;'));
	assert.ok(!/<script|<img|href=|<a\b|<iframe/i.test(html)); assert.ok(html.includes('<table>'));
	assert.ok(render('<img src="x" onerror="alert(1)">', 2).includes('&lt;img'));
	assert.ok(!render('[x](javascript:alert(1))').includes('href='));
});
test('draft pending request is immutable, exact-retryable, and failed saves do not discard text', () => {
	const d = new Draft(); d.load({ note: { ...note, body: 'a\r\nb' }, version: noteVersion(note), editable: true });
	d.edit('Different title', d.value.body);
	assert.equal(d.value.body, 'a\r\nb'); const original = d.submit(); d.edit('bad', 'bad');
	const returned = d.submit(); returned.body = 'mutated'; assert.deepEqual(d.submit(), original);
	assert.equal(d.dirty, true); d.rejectKnown(); d.edit('merge', 'preserved');
	d.rebase({ note: { ...note, body: 'new base' }, version: 'f'.repeat(64), editable: true });
	assert.equal(d.value.body, 'preserved'); assert.equal(d.submit().baseVersion, 'f'.repeat(64));
	d.load({ note, version: noteVersion(note), editable: true }); assert.equal(d.dirty, false);
});
test('actual Data API adapter uses metadata-only routes and blank POST followed by direct PUT', async t => {
	const calls = []; const base = await server(t, async (req, res) => {
		const u = new URL(req.url, 'http://localhost'); const body = req.method === 'GET' ? undefined : await readJson(req);
		calls.push({ u, method: req.method, body });
		res.end(JSON.stringify(req.method === 'GET' ? { items: [], has_more: false } : { ...note, ...body }));
	});
	const client = createJoplinClient({ baseUrl: base, token: 'test-api-token' });
	await client.listNoteSummaries({ notebookId: folderId, page: 2 });
	assert.equal(calls[0].u.pathname, `/folders/${folderId}/notes`); assert.ok(!calls[0].u.searchParams.get('fields').split(',').includes('body'));
	await client.createWebPlaceholder({ id: noteId, parentId: folderId, receipt: 'joplin-headless-web/v1:' + 'a'.repeat(64) });
	assert.equal(calls[1].body.body, '');
	const markdown = '![private](file:///etc/passwd)'; await client.updateNote(noteId, { body: markdown });
	assert.equal(calls[2].method, 'PUT'); assert.equal(calls[2].body.body, markdown);
});
