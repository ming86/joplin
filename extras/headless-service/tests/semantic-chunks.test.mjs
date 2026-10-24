import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticEngine } from '../src/semantic/engine.mjs';
import { chunkNote } from '../src/semantic/chunks.mjs';
import { noteFingerprint } from '../src/embeddings.mjs';
import { ServiceError } from '../src/errors.mjs';

const folder = 'a'.repeat(32), otherFolder = 'b'.repeat(32), tagId = 'c'.repeat(32);
const settings = { maxBytes: 256, overlapBytes: 20 };
/** Supplies current source notes and a fake ranked store while recording boundary inputs. */
function fixture() {
	const notes = new Map(); const candidates = []; const calls = { reads: [], tags: [], observed: [], removed: [], ranked: [], embedded: [] };
	const space = { id: 'test', preprocessingVersion: 'v1', queryPrefix: '' };
	const store = {
		accountId: 'alice', generation: 1, spaceFingerprint: 'space',
		async info() { return { counts: [{ state: 'indexed', count: notes.size }], rescan_checkpoint: '{"completedAt":1}', runtime: {}, usage: {} }; },
		async usage() {}, async close() {},
		async observe(note, hash) { calls.observed.push([note.id, hash]); },
		async remove(id) { calls.removed.push(id); },
		async rankChunks(vector, options) {
			calls.ranked.push({ vector, ...options });
			return candidates.filter(c => (!options.notebookId || c.parent === options.notebookId) && (!options.noteIds || options.noteIds.has(c.id)) && c.score >= options.minScore)
				.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.chunk.ordinal - b.chunk.ordinal).slice(0, options.limit);
		},
		async rank() { return candidates; },
	};
	const backend = {
		async getNote(id, signal) { calls.reads.push([id, signal]); if (!notes.has(id)) throw new ServiceError('not_found'); return { ...notes.get(id) }; },
		async getTagNoteIds(id, signal) { calls.tagScope = [id, signal]; return [...notes.keys()]; },
		async getNoteTags(id, signal) { calls.tags.push([id, signal]); return [{ id: tagId }]; },
		async search() { return { items: [...notes.values()] }; },
	};
	const provider = { space, async embed(texts, kind, signal) { calls.embedded.push([texts, kind, signal]); return { spaceFingerprint: 'space', vectors: [[1, 0]], inputTokens: 1 }; } };
	const engine = createSemanticEngine({ accountId: 'alice', store, backend, provider, chunks: settings });
	function add(index, body = 'public example text '.repeat(80), parent_id = folder) {
		const id = index.toString(16).padStart(32, '0');
		const note = { id, title: `Example ${index}`, body, parent_id, encryption_applied: 0, markup_language: 1 };
		notes.set(id, note);
		for (const chunk of chunkNote(note, settings)) candidates.push({ id, parent: parent_id, hash: noteFingerprint(note, space.preprocessingVersion), contentHash: chunk.hash, excerpt: 'short excerpt', score: 0.95 - chunk.ordinal / 1000, chunk: { ordinal: chunk.ordinal, start: chunk.start, end: chunk.end, offsetUnit: 'utf8-byte' } });
		return note;
	}
	return { engine, backend, provider, store, notes, candidates, calls, add };
}

test('dedicated search accepts free text and returns complete multiple chunks from one current note snapshot', async () => {
	const f = fixture(); const note = f.add(1); const signal = new AbortController().signal;
	const result = await f.engine.searchChunks({ query: 'How does title: work / -with punctuation?' }, signal);
	assert.ok(result.items.length > 1);
	assert.equal(result.total, result.items.length);
	for (const item of result.items) {
		assert.deepEqual(Object.keys(item), ['noteId', 'title', 'notebookId', 'chunkIndex', 'chunkText', 'score']);
		assert.equal(item.chunkText, chunkNote(note, settings)[item.chunkIndex].text);
		assert.notEqual(item.chunkText, 'short excerpt');
	}
	assert.equal(f.calls.reads.length, 1);
	assert.equal(f.calls.reads[0][1], signal);
	assert.equal(f.calls.embedded[0][2], signal);
	assert.equal(f.calls.ranked[0].signal, signal);
});

test('relevance caps strict/normal/loose chunks and applies each score floor before ranking', async () => {
	const f = fixture(); f.add(1, 'many chunks '.repeat(2000));
	for (const [relevance, limit] of [['strict', 5], ['normal', 10], ['loose', 20]]) {
		const result = await f.engine.searchChunks({ query: 'example', relevance });
		assert.equal(result.total, limit);
		assert.ok(result.items.every((item, i) => i === 0 || item.score <= result.items[i - 1].score));
		assert.equal(f.calls.ranked.at(-1).limit, 100);
		assert.equal(typeof f.calls.ranked.at(-1).minScore, 'number');
	}
	assert.ok(f.calls.ranked[0].minScore >= f.calls.ranked[1].minScore);
	assert.ok(f.calls.ranked[1].minScore >= f.calls.ranked[2].minScore);
});

test('notebook and tag scopes are passed before top-k and checked against current source', async () => {
	const f = fixture(); const included = f.add(1); f.add(2, 'unrelated text '.repeat(3000), otherFolder);
	const result = await f.engine.searchChunks({ query: 'example', notebookId: folder });
	assert.ok(result.items.every(item => item.noteId === included.id));
	assert.equal(f.calls.ranked[0].notebookId, folder);
	f.backend.getTagNoteIds = async (id, signal) => { f.calls.tagScope = [id, signal]; return [included.id]; };
	const signal = new AbortController().signal;
	const tagged = await f.engine.searchChunks({ query: 'example', tagId }, signal);
	assert.ok(tagged.items.every(item => item.noteId === included.id));
	assert.deepEqual(f.calls.ranked.at(-1).noteIds, new Set([included.id]));
	assert.deepEqual(f.calls.tagScope, [tagId, signal]);
	assert.equal(f.calls.tags.length, 1);
	assert.equal(f.calls.tags[0][1], signal);
	f.backend.getNoteTags = async () => [];
	assert.deepEqual(await f.engine.searchChunks({ query: 'example', tagId }), { items: [], total: 0 });
	assert.equal(f.calls.observed.at(-1)[0], included.id);
	included.parent_id = otherFolder;
	assert.equal((await f.engine.searchChunks({ query: 'example', notebookId: folder })).total, 0);
});

test('stale, missing, unreadable, and mismatched chunk candidates are suppressed and reconciled', async () => {
	for (const change of [
		f => { f.notes.values().next().value.body = 'changed'; },
		f => { f.notes.values().next().value.is_locked = 1; },
		f => { f.notes.clear(); },
		f => { f.candidates.forEach(c => c.contentHash = 'wrong'); },
		f => { f.candidates.forEach(c => c.chunk.start++); },
		f => { f.candidates.forEach(c => c.chunk.offsetUnit = 'character'); },
	]) {
		const f = fixture(); f.add(1); change(f);
		assert.deepEqual(await f.engine.searchChunks({ query: 'example' }), { items: [], total: 0 });
		assert.ok(f.calls.removed.length || f.calls.observed.length);
		assert.equal(f.calls.reads.length, 1);
	}
});

test('dedicated failures stay errors while existing note hybrid fallback remains available', async t => {
	const logs = []; const originalError = console.error; console.error = value => logs.push(JSON.parse(value));
	t.after(() => { console.error = originalError; });
	const f = fixture(); f.add(1);
	f.provider.embed = async () => { throw new ServiceError('embedding_provider_unavailable'); };
	await assert.rejects(f.engine.searchChunks({ query: 'example' }), { code: 'embedding_provider_unavailable' });
	const hybrid = await f.engine.search({ query: 'example', mode: 'hybrid' });
	assert.equal(hybrid.executedMode, 'keyword'); assert.equal(hybrid.items.length, 1);
	f.provider.embed = async () => ({ spaceFingerprint: 'space', vectors: [[1, 0]] });
	const cause = new Error('private provider text');
	f.store.rankChunks = async () => { throw cause; };
	await assert.rejects(f.engine.searchChunks({ query: 'example' }), error => error.code === 'semantic_unavailable' && error.cause === cause);
	assert.equal(logs.length, 1);
	assert.equal(logs[0].operation, 'semantic_chunk_search');
	assert.ok(!JSON.stringify(logs).includes('private provider text'));
	await assert.rejects(f.engine.searchChunks({ query: 'example' }));
	assert.equal(logs.length, 1); // The logger deduplicates the shared original cause.
	f.store.info = async () => { throw new ServiceError('semantic_store_closed'); };
	await assert.rejects(f.engine.searchChunks({ query: 'example' }), { code: 'semantic_store_closed' });
});

test('invalid dedicated inputs fail before provider and cancellation reaches every boundary', async () => {
	const f = fixture(); f.add(1);
	for (const args of [{ query: '' }, { query: 'x', relevance: 'unknown' }, { query: 'x', notebookId: folder, tagId }, { query: 'x', tagId: '' }]) await assert.rejects(f.engine.searchChunks(args), ServiceError);
	assert.equal(f.calls.embedded.length, 0);
	await assert.rejects(f.engine.search({ query: 'title:example' }), { code: 'semantic_query_syntax_not_supported' });
	await assert.rejects(f.engine.searchChunks({ query: 'x' }, AbortSignal.abort()), { code: 'request_cancelled' });
	for (const boundary of ['scope', 'embed', 'rank', 'note', 'tags']) {
		const g = fixture(); g.add(1); const controller = new AbortController();
		if (boundary === 'scope') g.backend.getTagNoteIds = async () => { controller.abort(); return [...g.notes.keys()]; };
		if (boundary === 'embed') g.provider.embed = async () => { controller.abort(); return { spaceFingerprint: 'space', vectors: [[1, 0]] }; };
		if (boundary === 'rank') { const original = g.store.rankChunks; g.store.rankChunks = async (...args) => { const result = await original(...args); controller.abort(); return result; }; }
		if (boundary === 'note') { const original = g.backend.getNote; g.backend.getNote = async (...args) => { const result = await original(...args); controller.abort(); return result; }; }
		if (boundary === 'tags') g.backend.getNoteTags = async () => { controller.abort(); return [{ id: tagId }]; };
		await assert.rejects(g.engine.searchChunks({ query: 'x', tagId }, controller.signal), { code: 'request_cancelled' });
	}
});

test('background per-note failures remain queued and diagnostics retain safe causes', async t => {
	const f = fixture(); const note = f.add(1); const logs = [];
	const originalError = console.error; console.error = value => logs.push(JSON.parse(value));
	t.after(() => { console.error = originalError; });
	const originalInfo = f.store.info;
	f.store.info = async () => ({ ...await originalInfo(), event_cursor: '0', rescan_checkpoint: JSON.stringify({ completedAt: Date.now() }) });
	f.backend.changes = async () => ({ cursor: '0', items: [], hasMore: false });
	f.store.enqueue = async () => {};
	f.store.due = async () => [{ note_id: note.id, revision: 1 }];
	let failed, paused;
	f.store.fail = async (...args) => { failed = args; };
	f.store.pause = async (...args) => { paused = args; };
	f.provider.embed = async () => { throw new ServiceError('embedding_provider_unavailable', false, undefined, { cause: new TypeError('private note and endpoint text') }); };
	await f.engine.runOnce();
	assert.equal(failed[0], note.id);
	assert.equal(failed[2], 'embedding_provider_unavailable');
	assert.ok(failed[3] > Date.now());
	assert.equal(paused[1], 'embedding_provider_unavailable');
	assert.equal(logs.length, 1);
	assert.equal(logs[0].operation, 'semantic_index_note');
	assert.equal(logs[0].errors[1].name, 'TypeError');
	assert.ok(!JSON.stringify(logs).includes('private note and endpoint text'));
});
