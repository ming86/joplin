import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRegistry } from '../index.mjs';
import { createJoplinClient } from '../src/joplin.mjs';
import { account, server, readJson, note, noteId, folderId } from './fixtures.mjs';
const code = expected => error => error.code === expected;

test('real loopback transport implements a Joplin-shaped read/write/search/events contract', async t => {
	let stored = { ...note }; const writes = [];
	const url = await server(t, async (req, res) => {
		const u = new URL(req.url, 'http://local');
		assert.equal(u.searchParams.get('token'), 'alice-private-token');
		res.setHeader('Content-Type', 'application/json');
		if (req.method === 'POST' || req.method === 'PUT') {
			const body = await readJson(req);
			writes.push([req.method, u.pathname, body]);
			if (req.method === 'PUT') assert.deepEqual(Object.keys(body), ['body']);
			stored = { ...stored, ...body }; return res.end(JSON.stringify(stored));
		}
		if (u.pathname === `/folders/${folderId}`) return res.end(JSON.stringify({ id: folderId, title: 'Notebook', parent_id: '', encryption_applied: 0, deleted_time: 0 }));
		if (u.pathname === '/folders') return res.end(JSON.stringify({ items: [{ id: folderId, title: 'Notebook', parent_id: '', encryption_applied: 0, deleted_time: 0 }], has_more: false }));
		if (u.pathname === '/events') return res.end(JSON.stringify({ items: [{ id: 1, item_id: noteId, item_type: 1, type: 1, created_time: 2 }], has_more: false, cursor: '1' }));
		if (u.pathname === `/notes/${noteId}`) return res.end(JSON.stringify({ ...stored, unexpected_secret: 'not exposed' }));
		return res.end(JSON.stringify({ items: [stored], has_more: false }));
	});
	const c = account(); c.joplin.baseUrl = url;
	const svc = createAccountRegistry([c]).forPrincipal('alice', 'alice');
	assert.equal((await svc.listNotebooks()).items[0].title, 'Notebook');
	const created = await svc.createNote({ title: '新笔记', body: 'hello', parentId: folderId }); assert.equal(created.title, '新笔记');
	assert.equal((await svc.updateNote(noteId, { body: 'updated' })).body, 'updated');
	assert.equal((await svc.getNote(noteId)).unexpected_secret, undefined);
	assert.equal((await svc.search({ query: 'updated', mode: 'hybrid' })).items[0].body, 'updated');
	assert.equal((await svc.listNotes()).items.length, 1);
	assert.equal((await svc.changes('0')).cursor, '1');
	assert.deepEqual(writes.map(([method]) => method), ['POST', 'PUT', 'PUT']);
	assert.equal(writes[0][2].body, '', 'POST carries no user-supplied Markdown body');
	assert.deepEqual(writes.slice(1).map(([, , body]) => body), [{ body: 'hello' }, { body: 'updated' }]);
});

test('path traversal, injected input properties and invalid pagination are rejected before sending', async t => {
	let count = 0; const url = await server(t, (_req, res) => { count++; res.end('{}'); });
	const client = createJoplinClient({ baseUrl: url, token: 'secret' });
	await assert.rejects(client.getNote('../resources'), code('invalid_note_or_notebook_id'));
	await assert.rejects(client.createNote({ title: 'x', body: 'x', parentId: folderId, body_html: '<img src=file:///private>' }), code('unsupported_note_property'));
	await assert.rejects(client.search('test', { page: 0 }), code('invalid_pagination'));
	await assert.rejects(client.changes('token=other'), code('invalid_cursor'));
	assert.equal(count, 0);
});

test('redirects are not followed and never disclose the API token to another origin', async t => {
	let received = 0;
	const sink = await server(t, (_req, res) => { received++; res.end('{}'); });
	const origin = await server(t, (_req, res) => { res.writeHead(302, { Location: sink }); res.end(); });
	const client = createJoplinClient({ baseUrl: origin, token: 'very-secret' });
	await assert.rejects(client.getNote(noteId), code('backend_unavailable'));
	assert.equal(received, 0);
});

test('body containing secrets is not retained in errors; request and response limits work', async t => {
	const bad = await server(t, (_req, res) => { res.writeHead(403); res.end('secret-token-and-content'); });
	const client = createJoplinClient({ baseUrl: bad, token: 'very-secret' });
	await assert.rejects(client.getNote(noteId), error => error.code === 'backend_authorization_failed' && !error.stack.includes('secret'));
	const huge = await server(t, (_req, res) => res.end('x'.repeat(100)));
	await assert.rejects(createJoplinClient({ baseUrl: huge, token: 'x', maxResponseBytes: 10 }).getNote(noteId), code('backend_response_too_large'));
	const slow = await server(t, () => {});
	await assert.rejects(createJoplinClient({ baseUrl: slow, token: 'x', timeoutMs: 30 }).getNote(noteId), code('backend_unavailable'));
});

test('ambiguous create failures are not automatically retried', async t => {
	let writes = 0;
	const url = await server(t, async (req, res) => { await readJson(req); writes++; res.destroy(); });
	const client = createJoplinClient({ baseUrl: url, token: 'x' });
	await assert.rejects(client.createNote({ title: 'x', body: 'y', parentId: folderId }), error => error.code === 'write_outcome_unknown' && error.outcomeUnknown === true);
	assert.equal(writes, 1);
});

test('invalid success payload after mutation is also an unknown outcome, not a retry instruction', async t => {
	const url = await server(t, (_req, res) => res.end('{}'));
	await assert.rejects(createJoplinClient({ baseUrl: url, token: 'x' }).updateNote(noteId, { body: 'value' }), code('write_outcome_unknown'));
});

test('malformed note property types are rejected instead of violating the declared interface', async t => {
	const url = await server(t, (_req, res) => res.end(JSON.stringify({ ...note, body: { secret: 'not note text' } })));
	await assert.rejects(createJoplinClient({ baseUrl: url, token: 'x' }).getNote(noteId), code('invalid_backend_response'));
});
