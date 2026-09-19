import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountRegistry } from '../index.mjs';
import { account, backend, noteId, note } from './fixtures.mjs';

const code = expected => error => error.code === expected;

test('one account works; two stub accounts with identical note IDs stay separate', async () => {
	const calls = [];
	const registry = createAccountRegistry([account(), account('bob')], { makeBackend(config) { calls.push(config); return backend(config.id); } });
	const a = registry.forPrincipal('alice', 'alice'); const b = registry.forPrincipal('bob', 'bob');
	const [an, bn] = await Promise.all([a.getNote(noteId), b.getNote(noteId)]);
	assert.equal(an.body, 'alice'); assert.equal(bn.body, 'bob');
	assert.equal(an.accountId, 'alice'); assert.equal(bn.accountId, 'bob');
	assert.notEqual(calls[0].semantic.databasePath, calls[1].semantic.databasePath);
	assert.notEqual(calls[0].semantic.keyRef, calls[1].semantic.keyRef);
	assert.notEqual(calls[0].joplin.token, calls[1].joplin.token);
	assert.equal((await a.listNotebooks()).items[0].accountId, 'alice');
	assert.equal((await a.changes()).accountId, 'alice');
	assert.equal(JSON.stringify(registry), '{}');
	assert(!JSON.stringify(a).includes('token'));
});

test('unknown and unauthorized accounts fail before backend/provider factories execute', () => {
	let calls = 0;
	const registry = createAccountRegistry([account()], { makeBackend() { calls++; throw new Error('should not run'); } });
	for (const [subject, id] of [['alice', 'bob'], ['mallory', 'alice'], [null, 'alice'], ['alice', '__proto__']]) {
		assert.throws(() => registry.forPrincipal(subject, id), code('account_not_available'));
	}
	assert.equal(calls, 0);
});

test('read-only permission is enforced for both create and update without calling a backend', async () => {
	const config = account(); config.permissions = ['read']; let calls = 0;
	const service = createAccountRegistry([config], { makeBackend() { calls++; return backend(); } }).forPrincipal('alice', 'alice');
	await assert.rejects(service.createNote({ title: 'x', body: 'x', parentId: noteId }), code('operation_not_permitted'));
	await assert.rejects(service.updateNote(noteId, { body: 'x' }), code('operation_not_permitted'));
	assert.equal(calls, 0);
});

test('startup configuration is copied, not shared mutable account state', async () => {
	const config = account();
	const registry = createAccountRegistry([config], { makeBackend: c => backend(c.id) });
	config.id = 'mallory'; config.subjects.push('mallory'); config.joplin.token = 'changed';
	assert.throws(() => registry.forPrincipal('mallory', 'alice'), code('account_not_available'));
	assert.equal((await registry.forPrincipal('alice', 'alice').getNote(noteId)).body, 'alice');
});

test('duplicate account, endpoint, key reference, and normalized/symlink store aliases are rejected', t => {
	for (const field of ['id', 'endpoint', 'key', 'path']) {
		const a = account(), b = account('bob');
		if (field === 'id') b.id = a.id;
		if (field === 'endpoint') b.joplin.baseUrl = `${a.joplin.baseUrl}/`;
		if (field === 'key') b.semantic.keyRef = a.semantic.keyRef;
		if (field === 'path') b.semantic.databasePath = `${path.dirname(a.semantic.databasePath)}/ignored/../semantic.db`;
		assert.throws(() => createAccountRegistry([a, b]), code('duplicate_account_binding'));
	}
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-bindings-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	fs.mkdirSync(`${temp}/real`); fs.symlinkSync(`${temp}/real`, `${temp}/alias`, 'dir');
	const a = account(), b = account('bob'); a.semantic.databasePath = `${temp}/real/new/db`; b.semantic.databasePath = `${temp}/alias/new/db`;
	assert.throws(() => createAccountRegistry([a, b]), code('duplicate_account_binding'));
});

test('encrypted, trashed and locked notes are unavailable and filtered from search', async () => {
	for (const fields of [{ encryption_applied: 1 }, { deleted_time: 100 }, { is_locked: 1 }]) {
		const fake = backend(); fake.getNote = async () => ({ ...note, ...fields });
		fake.search = async () => ({ items: [{ ...note, ...fields }, note], hasMore: false });
		fake.listNotes = fake.search;
		const service = createAccountRegistry([account()], { makeBackend: () => fake }).forPrincipal('alice', 'alice');
		await assert.rejects(service.getNote(noteId), code('note_unavailable'));
		await assert.rejects(service.updateNote(noteId, { body: 'overwrite' }), code('note_unavailable'));
		assert.equal((await service.search({ query: 'test' })).items.length, 1);
		assert.equal((await service.listNotes()).items.length, 1);
	}
});

test('semantic unavailability is explicit; hybrid falls back with truthful provenance', async () => {
	let calls = 0;
	const service = createAccountRegistry([account()], { makeBackend() { calls++; return backend(); } }).forPrincipal('alice', 'alice');
	const semantic = await service.search({ query: 'test', mode: 'semantic' });
	assert.equal(semantic.executedMode, null); assert.equal(semantic.semantic.state, 'unavailable'); assert.equal(calls, 0);
	const hybrid = await service.search({ query: 'test', mode: 'hybrid' });
	assert.equal(hybrid.requestedMode, 'hybrid'); assert.equal(hybrid.executedMode, 'keyword'); assert.equal(hybrid.items[0].provenance, 'keyword');
	await assert.rejects(service.search({ query: 'test', mode: 'made-up' }), code('invalid_search_mode'));
});

test('fake embedding transport receives only its bound account and purpose', async () => {
	const calls = [];
	const a = account(), b = account('bob'); b.embedding.space.id = 'bob-space'; b.embedding.space.queryPrefix = 'Q: ';
	const registry = createAccountRegistry([a, b], { makeEmbeddingTransport: config => async (texts, purpose) => {
		calls.push([config.id, config.semantic.keyRef, texts, purpose]); return { data: texts.map((_, index) => ({ index, embedding: [1, 0] })) };
	} });
	const ar = await registry.forPrincipal('alice', 'alice').embed(['first'], 'document');
	const br = await registry.forPrincipal('bob', 'bob').embed(['second'], 'query');
	assert.equal(ar.accountId, 'alice'); assert.equal(br.embeddingSpaceId, 'bob-space');
	assert.deepEqual(calls[1], ['bob', 'bob/semantic-key', ['Q: second'], 'query']);
});

test('unconfigured embeddings never look like an empty successful embedding batch', async () => {
	const service = createAccountRegistry([account()]).forPrincipal('alice', 'alice');
	await assert.rejects(service.embed(['x'], 'document'), code('embedding_provider_unavailable'));
});

test('remote embedding processing must be permitted explicitly', () => {
	const c = account(); c.embedding.baseUrl = 'https://example.invalid/v1';
	assert.throws(() => createAccountRegistry([c]), code('remote_processing_not_allowed'));
	c.embedding.remoteProcessing = true; assert.doesNotThrow(() => createAccountRegistry([c]));
});

test('non-Markdown notes remain readable but cannot be rewritten through the initial editor contract', async () => {
	const fake = backend(); fake.getNote = async () => ({ ...note, markup_language: 2 });
	const service = createAccountRegistry([account()], { makeBackend: () => fake }).forPrincipal('alice', 'alice');
	assert.equal((await service.getNote(noteId)).markup_language, 2);
	await assert.rejects(service.updateNote(noteId, { body: 'plain text' }), code('unsupported_note_format'));
});

test('missing account ID is rejected rather than coerced to a valid string', () => {
	const c = account(); delete c.id;
	assert.throws(() => createAccountRegistry([c]), code('invalid_configuration'));
});
