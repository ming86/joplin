import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRegistry } from '../index.mjs';
import { createJoplinClient } from '../src/joplin.mjs';
import { account, server, readJson, note, noteId, folderId } from './fixtures.mjs';
const code = expected => error => error.code === expected;

test('real loopback transport implements a Joplin-shaped read/write/search/events contract', async t => {
	let stored = { ...note }; const writes = []; const searchQueries = [];
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
		if (u.pathname === '/search') searchQueries.push(u.searchParams.get('query'));
		return res.end(JSON.stringify({ items: [stored], has_more: false }));
	});
	const c = account(); c.joplin.baseUrl = url;
	const svc = createAccountRegistry([c]).forPrincipal('alice', 'alice');
	assert.equal((await svc.listNotebooks()).items[0].title, 'Notebook');
	const created = await svc.createNote({ title: '新笔记', body: 'hello', parentId: folderId }); assert.equal(created.title, '新笔记');
	assert.equal((await svc.updateNote(noteId, { body: 'updated' })).body, 'updated');
	assert.equal((await svc.getNote(noteId)).unexpected_secret, undefined);
	assert.equal((await svc.search({ query: 'updated', mode: 'hybrid' })).items[0].body, 'updated');
	const longQuery = 'q'.repeat(10001);
	assert.equal((await svc.search({ query: longQuery, mode: 'keyword' })).total, 1);
	assert.deepEqual(searchQueries, ['updated', 'updated', longQuery, longQuery]);
	assert.equal((await svc.listNotes()).items.length, 1);
	assert.equal((await svc.changes('0')).cursor, '1');
	assert.deepEqual(writes.map(([method]) => method), ['POST', 'PUT', 'PUT']);
	assert.equal(writes[0][2].body, '', 'POST carries no user-supplied Markdown body');
	assert.deepEqual(writes.slice(1).map(([, , body]) => body), [{ body: 'hello' }, { body: 'updated' }]);
});

test('Joplin note adapter carries due and source URL fields through split-body creates and reads origin metadata', async t => {
	const writes = [];
	let stored;
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://local');
		res.setHeader('Content-Type', 'application/json');
		if (req.method === 'POST' || req.method === 'PUT') {
			const body = await readJson(req);
			writes.push([req.method, target.pathname, body]);
			if (req.method === 'POST') {
				stored = {
					...body,
					id: noteId,
					created_time: 1,
					updated_time: 2,
					source: 'mobile-import',
					source_application: 'net.example.mobile',
					encryption_applied: 0,
					deleted_time: 0,
					is_locked: 0,
				};
			} else stored = { ...stored, ...body };
			return res.end(JSON.stringify(stored));
		}
		if (req.method === 'GET' && target.pathname === `/notes/${noteId}`) {
			assert.match(target.searchParams.get('fields'), /(?:^|,)todo_due(?:,|$)/);
			assert.match(target.searchParams.get('fields'), /(?:^|,)source(?:,|$)/);
			assert.match(target.searchParams.get('fields'), /(?:^|,)source_application(?:,|$)/);
			assert.match(target.searchParams.get('fields'), /(?:^|,)source_url(?:,|$)/);
			return res.end(JSON.stringify(stored));
		}
		res.writeHead(404); res.end();
	});
	const client = createJoplinClient({ baseUrl: url, token: 'private' });
	const created = await client.createNote({
		title: 'Imported reminder',
		body: 'body supplied through a file input',
		parentId: folderId,
		is_todo: 1,
		todo_due: 0,
		source_url: 'https://example.test/article',
	});
	assert.equal(created.todo_due, 0);
	assert.equal(created.source_url, 'https://example.test/article');
	assert.deepEqual(writes.slice(0, 2), [
		['POST', '/notes', { title: 'Imported reminder', body: '', parent_id: folderId, is_todo: 1, todo_due: 0, source_url: 'https://example.test/article', markup_language: 1 }],
		['PUT', `/notes/${noteId}`, { body: 'body supplied through a file input' }],
	]);

	const updated = await client.updateNote(noteId, { is_todo: 0, todo_due: -1, source_url: '' });
	assert.equal(updated.todo_due, -1);
	assert.equal(updated.source_url, '');
	assert.deepEqual(writes[2], ['PUT', `/notes/${noteId}`, { is_todo: 0, todo_due: -1, source_url: '' }]);

	const read = await client.getNote(noteId);
	assert.equal(read.source, 'mobile-import');
	assert.equal(read.source_application, 'net.example.mobile');
	assert.equal(read.todo_due, -1);
	assert.equal(read.source_url, '');
	await assert.rejects(client.updateNote(noteId, { source: 'caller-supplied-origin' }), code('unsupported_note_property'));
});

test('complete backend collections continue beyond 50 pages until has_more is false', async t => {
	const pages = [];
	const url = await server(t, (req, res) => {
		const target = new URL(req.url, 'http://local');
		const page = Number(target.searchParams.get('page'));
		pages.push(page);
		res.end(JSON.stringify({
			items: [{ id: String(page).padStart(32, '0'), title: `Tag ${page}`, encryption_applied: 0 }],
			has_more: page < 51,
		}));
	});
	const tags = await createJoplinClient({ baseUrl: url, token: 'private' }).listAllTags();
	assert.equal(tags.length, 51);
	assert.deepEqual(pages, Array.from({ length: 51 }, (_, index) => index + 1));
});

test('tag note IDs read only IDs across every page and honor cancellation', async t => {
	const tagId = 'd'.repeat(32);
	const noteIds = [noteId, 'e'.repeat(32)];
	const pages = [];
	const url = await server(t, (req, res) => {
		const target = new URL(req.url, 'http://local');
		assert.equal(target.pathname, `/tags/${tagId}/notes`);
		assert.equal(target.searchParams.get('fields'), 'id');
		assert.equal(target.searchParams.get('limit'), '100');
		const page = Number(target.searchParams.get('page'));
		pages.push(page);
		res.end(JSON.stringify({ items: [{ id: noteIds[page - 1] }], has_more: page === 1 }));
	});
	const client = createJoplinClient({ baseUrl: url, token: 'private' });

	assert.deepEqual(await client.getTagNoteIds(tagId), noteIds);
	assert.deepEqual(pages, [1, 2], 'the final page is read before returning all note IDs');
	await assert.rejects(client.getTagNoteIds(tagId, AbortSignal.abort()), code('request_cancelled'));
	assert.deepEqual(pages, [1, 2], 'a pre-cancelled read sends no request');
});

test('headless status uses its fixed authenticated action, allowlists the summary, and fails explicitly', async t => {
	let fail = false, accountEmail = 'alice@example.test', syncRunning = true, syncKind = 'full';
	let periodicTiming = { startTime: 1600, completedTime: 1800 };
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://local');
		assert.equal(target.pathname, '/services/headless');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		assert.equal(req.method, 'POST');
		assert.deepEqual(await readJson(req), { action: 'status' });
		if (fail) { res.writeHead(503); return res.end('private upstream error'); }
		res.end(JSON.stringify({
			accountEmail,
			observedAt: 2000,
			serviceStartedAt: 1000,
			sync: {
				running: syncRunning,
				pending: false,
				kind: syncKind,
				lastPeriodicFullSync: periodicTiming && { ...periodicTiming, privateField: 'not exposed' },
				report: { state: 'in_progress', startTime: 1500, completedTime: null, counters: { noteConflict: 2, updateLocal: 3, privateCounter: 99 }, errorCount: 1, errors: ['private error'] },
				privateField: 'not exposed',
			},
			decryption: { state: 'started', batch: { itemIndex: 1, itemCount: 8, privateField: 'not exposed' }, missingMasterKey: true, disabledItemCount: 4, error: 'private error' },
			privateField: 'not exposed',
		}));
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal('alice', 'alice');
	const status = await service.status();
	assert.deepEqual(status, {
		accountId: 'alice',
		accountEmail: 'alice@example.test',
		semantic: { state: 'unavailable', reason: 'not_implemented', embeddingSpaceId: 'test-space-v1' },
		observedAt: 2000,
		serviceStartedAt: 1000,
		sync: { running: true, pending: false, kind: 'full', lastPeriodicFullSync: { startTime: 1600, completedTime: 1800 }, report: { state: 'in_progress', startTime: 1500, completedTime: null, counters: { noteConflict: 2, updateLocal: 3 }, errorCount: 1 } },
		decryption: { state: 'started', batch: { itemIndex: 1, itemCount: 8 }, missingMasterKey: true, disabledItemCount: 4 },
	});
	assert.deepEqual(status.sync.lastPeriodicFullSync, { startTime: 1600, completedTime: 1800 });
	for (const [kind, running] of [['full', true], ['upload', false], ['poll', false], [null, false]]) {
		syncKind = kind;
		syncRunning = running;
		const result = await service.status();
		assert.equal(result.sync.kind, kind);
		assert.equal(result.sync.running, running);
	}
	periodicTiming = null;
	assert.equal((await service.status()).sync.lastPeriodicFullSync, null);
	periodicTiming = { startTime: 1600, completedTime: 1800 };
	syncKind = 'unknown';
	await assert.rejects(service.status(), code('invalid_backend_response'));
	syncKind = 'poll';
	syncRunning = false;
	periodicTiming = { startTime: -1, completedTime: null };
	await assert.rejects(service.status(), code('invalid_backend_response'));
	periodicTiming = undefined;
	await assert.rejects(service.status(), code('invalid_backend_response'));
	periodicTiming = { startTime: 1600, completedTime: 1800 };
	accountEmail = null;
	assert.equal((await service.status()).accountEmail, null);
	accountEmail = 42;
	await assert.rejects(service.status(), code('invalid_backend_response'));
	fail = true;
	await assert.rejects(service.status(), code('backend_request_failed'));
});

test('notebook counts use the fixed read-only core action and validate aggregate values', async t => {
	let responseBody = { counts: { '': 2, orphanParent: 3, [folderId]: 0 }, privateField: 'not exposed' };
	let fail = false;
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://local');
		assert.equal(target.pathname, '/services/headless');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		assert.equal(req.method, 'POST');
		assert.deepEqual(await readJson(req), { action: 'notebookNoteCounts' });
		if (fail) { res.writeHead(503); return res.end('private upstream error'); }
		res.end(JSON.stringify(responseBody));
	});
	const config = account(); config.joplin.baseUrl = url;
	const client = createJoplinClient(config.joplin);
	assert.deepEqual(await client.notebookNoteCounts(), { '': 2, orphanParent: 3, [folderId]: 0 });
	for (const counts of [null, [], { [folderId]: -1 }, { [folderId]: 1.5 }, { [folderId]: '1' }]) {
		responseBody = { counts };
		await assert.rejects(client.notebookNoteCounts(), code('invalid_backend_response'));
	}
	fail = true;
	await assert.rejects(client.notebookNoteCounts(), code('backend_request_failed'));
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

test('body containing secrets is not retained in errors; response bodies are buffered and timeouts remain bounded', async t => {
	const bad = await server(t, (_req, res) => { res.writeHead(403); res.end('secret-token-and-content'); });
	const client = createJoplinClient({ baseUrl: bad, token: 'very-secret' });
	await assert.rejects(client.getNote(noteId), error => error.code === 'backend_authorization_failed' && !error.stack.includes('secret'));
	const largeResponse = JSON.stringify({ ...note, padding: 'x'.repeat(8 * 1024 * 1024) });
	const huge = await server(t, (_req, res) => res.end(largeResponse));
	assert.equal((await createJoplinClient({ baseUrl: huge, token: 'x' }).getNote(noteId)).id, noteId);
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
