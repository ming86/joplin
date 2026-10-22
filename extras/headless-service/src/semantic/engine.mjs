import { ServiceError, requireValue, identifier, pagination } from '../errors.mjs';
import { noteFingerprint } from '../embeddings.mjs';
import { chunkSettings, chunkNote, isIndexable, fuseRanks } from './chunks.mjs';

export function createSemanticEngine({ accountId, backend, provider, store, chunks, pollMs = 5000, rescanMs = 300000, batchSize = 16, now = Date.now }) {
	requireValue(accountId === store.accountId && provider.space, 'semantic_account_mismatch');
	for (const [n, min, max] of [[pollMs, 100, 60000], [rescanMs, 100, 86400000], [batchSize, 1, 128]]) requireValue(Number.isSafeInteger(n) && n >= min && n <= max);
	const settings = chunkSettings(chunks); const fingerprint = note => noteFingerprint(note, provider.space.preprocessingVersion);
	const controller = new AbortController(); let timer; let inFlight; let stopping = false;
	let status = { state: 'indexing', embeddingSpaceId: provider.space.id, generation: store.generation, initialScanComplete: false, pendingNotes: 0, indexedNotes: 0, failedNotes: 0 };
	let failures = 0;
	async function refresh(error) {
		const info = await store.info(); const counts = Object.fromEntries(info.counts.map(row => [row.state, row.count]));
		let checkpoint = {}; try { checkpoint = JSON.parse(info.rescan_checkpoint ?? '{}') ?? {}; } catch { /* incomplete scan will restart */ }
		status = {
			state: error || (counts.error ?? 0) > 0 || info.runtime.retry_after > now() ? 'degraded' : !checkpoint.completedAt || counts.pending ? 'indexing' : 'ready',
			...(error || info.runtime.last_error ? { reason: error ?? info.runtime.last_error } : {}),
			embeddingSpaceId: provider.space.id, generation: store.generation, initialScanComplete: !!checkpoint.completedAt,
			pendingNotes: counts.pending ?? 0, indexedNotes: counts.indexed ?? 0, failedNotes: counts.error ?? 0,
			lastReconciledAt: checkpoint.completedAt ?? null, providerRetryAt: info.runtime.retry_after || null,
			usage: { inputTokens: info.usage.input_tokens, preparedBytes: info.usage.prepared_bytes, successfulRequests: info.usage.requests },
		};
		return info;
	}
	const aborted = signal => { if (signal?.aborted) throw new ServiceError('request_cancelled'); };
	async function current(id, signal) {
		try { return await backend.getNote(id, signal); } catch (error) { if (error.code === 'not_found') return null; throw error; }
	}
	async function reconcile(signal) {
		const seen = new Set(); let page = 1;
		while (true) {
			aborted(signal);
			const result = await (backend.listIndexNotes ?? backend.listNotes).call(backend, { page, limit: 50 }, signal);
			for (const item of result.items) {
				identifier(item.id); seen.add(item.id);
				const note = Object.hasOwn(item, 'body') ? item : await current(item.id, signal);
				if (!note) { await store.remove(item.id); continue; }
				if (isIndexable(note)) await store.observe(note, fingerprint(note)); else await store.remove(note.id);
			}
			await store.checkpoint({ page, inProgress: true });
			if (!result.hasMore) break;
			requireValue(result.items.length > 0 && page < 100000, 'invalid_backend_pagination'); page++;
		}
		// An ID missed by offset pagination may still exist. Confirm absence or
		// ineligibility, never infer deletion merely from not appearing in a page.
		for (const id of await store.ids()) {
			if (seen.has(id)) continue;
			aborted(signal); const note = await current(id, signal);
			if (isIndexable(note)) await store.observe(note, fingerprint(note)); else await store.remove(id);
		}
		await store.checkpoint({ completedAt: now() });
	}
	async function processNote(job, signal) {
		const note = await current(job.note_id, signal);
		if (!isIndexable(note)) { await store.remove(job.note_id); return; }
		const hash = fingerprint(note);
		let values = null;
		if (hash !== job.source_fingerprint) {
			values = chunkNote(note, settings);
			for (let start = 0; start < values.length; start += batchSize) {
				aborted(signal); const batch = values.slice(start, start + batchSize);
				const result = await provider.embed(batch.map(chunk => chunk.text), 'document', signal);
				requireValue(result.spaceFingerprint === store.spaceFingerprint, 'embedding_space_mismatch');
				await store.usage(result.inputTokens, batch.reduce((n, c) => n + Buffer.byteLength(provider.space.documentPrefix + c.text), 0));
				for (let i = 0; i < batch.length; i++) batch[i].vector = result.vectors[i];
			}
		}
		const latest = await current(job.note_id, signal); aborted(signal);
		if (!isIndexable(latest)) { await store.remove(job.note_id); return; }
		if (fingerprint(latest) !== hash) { await store.observe(latest, fingerprint(latest)); return; }
		await store.publish(latest, job.revision, hash, values);
	}
	async function cycle(signal, forceRescan) {
		try {
			let info = await refresh();
			const head = await backend.changes(undefined, signal);
			let cursor = info.event_cursor;
			if (cursor === null || BigInt(cursor) > BigInt(head.cursor)) {
				await store.enqueue([], head.cursor); cursor = head.cursor; forceRescan = true;
			}
			let checkpoint = {}; try { checkpoint = JSON.parse(info.rescan_checkpoint ?? '{}') ?? {}; } catch { /* rescan */ }
			if (forceRescan || !checkpoint.completedAt || now() - checkpoint.completedAt >= rescanMs) await reconcile(signal);
			// Bounded change draining; the cursor and queued IDs commit together.
			for (let i = 0; i < 10; i++) {
				aborted(signal); const changes = await backend.changes(cursor, signal);
				const ids = changes.items.filter(item => item.itemType === undefined || item.itemType === 1).map(item => identifier(item.itemId));
				requireValue(!changes.hasMore || changes.cursor !== cursor, 'invalid_backend_cursor');
				await store.enqueue(ids, changes.cursor); cursor = changes.cursor;
				if (!changes.hasMore) break;
			}
			info = await store.info();
			if (info.runtime.retry_after > now()) { await refresh(); return; }
			for (const job of await store.due(now())) {
				try {
					await processNote(job, signal); failures = 0; await store.pause(0, null);
				} catch (error) {
					aborted(signal);
					const code = error instanceof ServiceError ? error.code : 'semantic_indexing_failed';
					failures = Math.min(failures + 1, 8);
					const retryAt = now() + Math.max(Math.min(error.retryAfterMs ?? 0, 86400000), Math.min(300000, 1000 * 2 ** failures));
					await store.fail(job.note_id, job.revision, code, retryAt);
					if (['embedding_rate_limited', 'embedding_provider_unavailable', 'embedding_authorization_failed', 'invalid_embedding_response'].includes(code)) { await store.pause(retryAt, code); break; }
				}
			}
			await refresh();
		} catch (error) {
			if (signal?.aborted) return;
			await refresh(error instanceof ServiceError ? error.code : 'semantic_indexing_failed').catch(() => { status = { ...status, state: 'unavailable', reason: 'semantic_store_unavailable' }; });
			throw error;
		}
	}
	function runOnce({ signal, rescan = false } = {}) {
		if (stopping) return Promise.reject(new ServiceError('semantic_closed'));
		if (inFlight) return inFlight;
		const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
		inFlight = cycle(combined, rescan).finally(() => { inFlight = null; }); return inFlight;
	}
	const engine = {
		accountId,
		initialize: () => refresh(),
		status: () => structuredClone(status),
		runOnce,
		start() {
			if (timer || stopping) return;
			const next = async () => { await runOnce().catch(() => {}); if (!stopping) timer = setTimeout(next, pollMs); };
			timer = setTimeout(next, 0);
		},
		async search({ query, mode = 'semantic', page = 1, limit = 20, notebookId }, signal) {
			pagination({ page, limit }); requireValue(page === 1, 'semantic_pagination_not_supported');
			requireValue(typeof query === 'string' && query.trim().length > 0, 'invalid_query');
			// Do not ignore Joplin filters/negations and leak out-of-scope matches.
			requireValue(!/(?:^|\s)(?:-\S|\w+:|\/)/u.test(query), 'semantic_query_syntax_not_supported');
			if (notebookId) identifier(notebookId);
			aborted(signal); await refresh();
			const lexical = mode === 'hybrid' ? (await backend.search(query, { page: 1, limit: 100 }, signal)).items.filter(n => isIndexable(n) && (!notebookId || n.parent_id === notebookId)) : [];
			let semantic = [], failure;
			try {
				if (status.providerRetryAt && status.providerRetryAt > now()) throw new ServiceError(status.reason ?? 'embedding_provider_unavailable');
				const result = await provider.embed([query], 'query', signal);
				requireValue(result.spaceFingerprint === store.spaceFingerprint, 'embedding_space_mismatch');
				await store.usage(result.inputTokens, Buffer.byteLength(provider.space.queryPrefix + query));
				for (const candidate of await store.rank(result.vectors[0], 100, notebookId)) {
					aborted(signal); const note = await current(candidate.id, signal);
					if (!isIndexable(note)) { await store.remove(candidate.id); continue; }
					if (fingerprint(note) !== candidate.hash || (notebookId && note.parent_id !== notebookId)) { await store.observe(note, fingerprint(note)); continue; }
					semantic.push({ ...note, score: candidate.score, semanticExcerpt: candidate.excerpt, chunk: candidate.chunk, provenance: 'semantic' });
				}
			} catch (error) {
				aborted(signal);
				failure = error instanceof ServiceError ? error.code : 'semantic_unavailable';
			}
			const all = mode === 'hybrid' && !failure ? fuseRanks(lexical, semantic, 100) : mode === 'hybrid' ? lexical.map(n => ({ ...n, provenance: 'keyword' })) : semantic;
			return { accountId, requestedMode: mode, executedMode: failure ? mode === 'hybrid' ? 'keyword' : null : mode,
				semantic: failure ? { ...engine.status(), state: 'degraded', reason: failure } : engine.status(),
				items: all.slice(0, limit).map(n => ({ ...n, accountId })), hasMore: false,
				candidateWindow: 100, truncated: all.length > limit, ...(notebookId ? { notebookId } : {}),
			};
		},
		async close() { if (stopping) return; stopping = true; clearTimeout(timer); controller.abort(); await inFlight?.catch(() => {}); await store.close(); },
	};
	return Object.freeze(engine);
}
