import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { requireValue, ServiceError, identifier } from '../errors.mjs';
import { embeddingSpace, embeddingFingerprint } from '../embeddings.mjs';
import { chunkFingerprint } from './chunks.mjs';

const require = createRequire(import.meta.url);
const appId = 1246971185;
/** Maximum rows loaded by one exact vector-ranking query. */
const rankBatchSize = 200;

/** Stop a ranking scan with the same public cancellation code used by the service.
 * @param {AbortSignal | undefined} signal Caller cancellation signal.
 */
function throwIfRankingAborted(signal) {
	if (signal?.aborted) throw new ServiceError('request_cancelled');
}

/** Order higher scores first, then note ID and (for chunk results) ordinal.
 * @param {{id: string, score: number, chunk: {ordinal: number}}} a First candidate.
 * @param {{id: string, score: number, chunk: {ordinal: number}}} b Second candidate.
 * @param {boolean} byChunk Whether chunk ordinal is the final tie-breaker.
 * @returns {number} Comparator result for Array#sort.
 */
function compareRankedCandidates(a, b, byChunk) {
	return b.score - a.score || a.id.localeCompare(b.id) || (byChunk ? a.chunk.ordinal - b.chunk.ordinal : 0);
}

// One owner per semantic DB. This is deliberately independent of Joplin's DB
// and imports no Joplin internals. All connection work is queued so await points
// cannot accidentally interleave another transaction on the same connection.
export async function openSemanticStore({ filename, accountId, key, sqliteModule, space: input, model, chunks, rebuild = false }) {
	requireValue(path.isAbsolute(filename) && path.isAbsolute(sqliteModule ?? ''), 'absolute_path_required');
	requireValue(typeof accountId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(accountId));
	requireValue(typeof key === 'string' && /^[a-fA-F0-9]{64}$/.test(key), 'invalid_semantic_key');
	requireValue(typeof model === 'string' && model.length > 0);
	const space = embeddingSpace(input); const fingerprint = embeddingFingerprint(space); const chunker = chunkFingerprint(chunks);
	fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
	filename = path.join(fs.realpathSync(path.dirname(filename)), path.basename(filename));
	if (fs.existsSync(filename)) requireValue(fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink(), 'invalid_semantic_store');
	const lease = `${filename}.lock`; let ownsLease = false; let db;
	const release = () => { if (ownsLease) { fs.rmSync(lease, { recursive: true, force: true }); ownsLease = false; } };
	const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
	const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
	const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve(this.changes); }));
	const one = async (sql, args = []) => (await all(sql, args))[0];
	async function tx(work) { await exec('BEGIN IMMEDIATE'); try { const result = await work(); await exec('COMMIT'); return result; } catch (e) { await exec('ROLLBACK').catch(() => {}); throw e; } }
	let tail = Promise.resolve(); let closed = false;
	function queued(work) {
		if (closed) return Promise.reject(new ServiceError('semantic_store_closed'));
		const job = tail.then(work).catch(error => { throw error instanceof ServiceError ? error : new ServiceError('semantic_store_error', false, undefined, { cause: error }); });
		tail = job.catch(() => {}); return job;
	}
	try {
		try { fs.mkdirSync(lease, { mode: 0o700 }); ownsLease = true; } catch (error) {
			if (error?.code === 'EEXIST') throw new ServiceError('semantic_store_in_use', false, undefined, { cause: error });
			throw error;
		}
		fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
		if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, 'wx', 0o600));
		fs.chmodSync(filename, 0o600);
		const sqlite = require(sqliteModule);
		db = await new Promise((resolve, reject) => { const instance = new sqlite.Database(filename, error => error ? reject(error) : resolve(instance)); });
		await exec(`PRAGMA key = "x'${key}'";`); key = undefined;
		const version = await one('PRAGMA cipher_version');
		requireValue(version && /^4\./.test(Object.values(version)[0]), 'sqlcipher_4_required');
		await exec('PRAGMA cipher_compatibility=4; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
		const tables = await one('SELECT count(*) AS n FROM sqlite_master');
		if (tables.n === 0) {
			await tx(async () => {
				await exec(fs.readFileSync(fileURLToPath(new URL('../../schema/semantic-v1.sql', import.meta.url)), 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
				await exec(`ALTER TABLE note_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
				ALTER TABLE note_state ADD COLUMN observed_fingerprint TEXT;
				ALTER TABLE note_state ADD COLUMN parent_id TEXT;
				CREATE TABLE store_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), account_id TEXT NOT NULL, provider_model TEXT NOT NULL);
				CREATE TABLE runtime_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),retry_after INTEGER NOT NULL DEFAULT 0,last_error TEXT);
				CREATE TABLE usage(singleton INTEGER PRIMARY KEY CHECK(singleton=1), input_tokens INTEGER NOT NULL DEFAULT 0, prepared_bytes INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0);`);
				await run('INSERT INTO store_owner VALUES(1,?,?)', [accountId, model]);
				await run("INSERT INTO index_config VALUES(1,1,?,?,?,'cosine',?,?,?)", [space.id, fingerprint, space.dimensions, space.normalization, space.preprocessingVersion, chunker]);
				await run('INSERT INTO sync_state VALUES(1,NULL,NULL)'); await run('INSERT INTO usage(singleton) VALUES(1)'); await run('INSERT INTO runtime_state(singleton) VALUES(1)');
			});
		}
		requireValue((await one('PRAGMA application_id')).application_id === appId && (await one('PRAGMA user_version')).user_version === 1, 'unsupported_semantic_store');
		const owner = await one('SELECT * FROM store_owner');
		requireValue(owner?.account_id === accountId, 'semantic_account_mismatch');
		let index = await one('SELECT * FROM index_config');
		requireValue(index, 'unsupported_semantic_store');
		if (index.space_fingerprint !== fingerprint || index.chunker_version !== chunker || owner.provider_model !== model) {
			requireValue(rebuild === true, 'semantic_rebuild_required');
			await tx(async () => {
				await exec('DELETE FROM chunks; DELETE FROM note_state;');
				await run("UPDATE index_config SET generation=generation+1,embedding_space_id=?,space_fingerprint=?,dimensions=?,normalization=?,preprocessing_version=?,chunker_version=?", [space.id, fingerprint, space.dimensions, space.normalization, space.preprocessingVersion, chunker]);
				await run('UPDATE store_owner SET provider_model=?', [model]);
				await exec('UPDATE sync_state SET event_cursor=NULL,rescan_checkpoint=NULL; UPDATE runtime_state SET retry_after=0,last_error=NULL;');
			});
			index = await one('SELECT * FROM index_config');
		}
		await all('PRAGMA journal_mode=WAL');
		const generation = index.generation;
		async function enqueue(id) {
			identifier(id);
			await run(`INSERT INTO note_state(note_id,generation,state,revision) VALUES(?,?,'pending',1)
				ON CONFLICT(note_id) DO UPDATE SET state='pending',revision=revision+1,error_code=NULL,retry_after=NULL,observed_fingerprint=NULL`, [id, generation]);
		}
		/**
		 * Scan vectors in fixed-size row batches while retaining only the current top results.
		 * Note ranking keeps one best chunk per note; chunk ranking keeps each eligible chunk.
		 * @param {number[]} vector Query vector in the store's embedding space.
		 * @param {object} options Ranking and filtering options.
		 * @param {number} options.limit Maximum number of returned results.
		 * @param {string} [options.notebookId] Restricts rows in SQL before scanning.
		 * @param {Set<string>} [options.noteIds] Restricts scoring to these note IDs.
		 * @param {number} options.minScore Minimum cosine score for chunk ranking.
		 * @param {AbortSignal} [options.signal] Cancels the scan between row batches.
		 * @param {boolean} options.byChunk Whether results represent individual chunks.
		 * @returns {Promise<Array<object>>} Sorted candidates in the existing store result shape.
		 */
		async function rankVector(vector, { limit = 100, notebookId, noteIds, minScore = -1, signal, byChunk = false }) {
			requireValue(vector.length === space.dimensions && vector.every(Number.isFinite), 'invalid_embedding_response');
			const norm = Math.hypot(...vector); requireValue(norm > 0 && Number.isFinite(norm), 'invalid_embedding_response');
			if (notebookId) identifier(notebookId);
			if (noteIds !== undefined) requireValue(noteIds instanceof Set, 'invalid_configuration');
			if (byChunk) {
				requireValue(Number.isSafeInteger(limit) && limit >= 0 && Number.isFinite(minScore), 'invalid_configuration');
			}
			throwIfRankingAborted(signal);
			if (noteIds?.size === 0) return [];
			let after = 0; const best = new Map();
			while (true) {
				throwIfRankingAborted(signal);
				const rows = await all(`SELECT c.rowid AS row_id,c.*,n.source_fingerprint FROM chunks c JOIN note_state n ON c.note_id=n.note_id
					WHERE n.state='indexed' AND c.rowid>? ${notebookId ? 'AND n.parent_id=?' : ''} ORDER BY c.rowid LIMIT ${rankBatchSize}`, notebookId ? [after, notebookId] : [after]);
				throwIfRankingAborted(signal);
				if (!rows.length) break;
				// Apply the caller's allowed-ID scope before decoding or scoring stored vectors.
				const eligibleRows = noteIds === undefined ? rows : rows.filter(row => noteIds.has(row.note_id));
				for (const row of eligibleRows) {
					let dot = 0, squared = 0;
					for (let i = 0; i < vector.length; i++) { const v = row.vector.readFloatLE(i * 4); dot += vector[i] * v; squared += v * v; }
					const score = dot / (norm * Math.sqrt(squared)); if (!Number.isFinite(score)) throw new ServiceError('invalid_stored_vector');
					if (byChunk && score < minScore) continue;
					const candidate = {
						id: row.note_id, score, hash: row.source_fingerprint, excerpt: row.excerpt,
						chunk: { ordinal: row.ordinal, start: row.start_offset, end: row.end_offset, offsetUnit: 'utf8-byte' },
					};
					if (byChunk) candidate.contentHash = row.content_hash;
					const key = byChunk ? row.row_id : row.note_id;
					const prior = best.get(key);
					if (!prior || score > prior.score) best.set(key, candidate);
				}
				after = rows.at(-1).row_id;
				if (best.size > limit) {
					const kept = [...best.entries()].sort(([, a], [, b]) => compareRankedCandidates(a, b, byChunk)).slice(0, limit);
					best.clear(); for (const [key, candidate] of kept) best.set(key, candidate);
				}
			}
			return [...best.values()].sort((a, b) => compareRankedCandidates(a, b, byChunk)).slice(0, limit);
		}
		return Object.freeze({
			accountId, generation, spaceFingerprint: fingerprint,
			info: () => queued(async () => ({ ...(await one('SELECT * FROM sync_state')), counts: await all('SELECT state,count(*) AS count FROM note_state GROUP BY state'), usage: await one('SELECT * FROM usage'), runtime: await one('SELECT * FROM runtime_state') })),
			state: id => queued(() => one('SELECT * FROM note_state WHERE note_id=?', [identifier(id)])),
			ids: () => queued(async () => (await all('SELECT note_id FROM note_state')).map(row => row.note_id)),
			enqueue: (ids, cursor) => queued(() => tx(async () => {
				for (const id of new Set(ids)) await enqueue(id);
				if (cursor !== undefined) { requireValue(typeof cursor === 'string' && /^\d+$/.test(cursor), 'invalid_cursor'); await run('UPDATE sync_state SET event_cursor=?', [cursor]); }
			})),
			observe: (note, hash) => queued(() => tx(async () => {
				const row = await one('SELECT * FROM note_state WHERE note_id=?', [identifier(note.id)]);
				if (!row || row.state === 'deleted' || (row.state === 'indexed' && row.parent_id !== note.parent_id) || (row.observed_fingerprint !== hash && !(row.state === 'indexed' && row.source_fingerprint === hash && row.parent_id === note.parent_id))) await enqueue(note.id);
				await run('UPDATE note_state SET observed_fingerprint=? WHERE note_id=?', [hash, note.id]);
			})),
			checkpoint: value => queued(() => run('UPDATE sync_state SET rescan_checkpoint=?', [JSON.stringify(value)])),
			due: (now, limit = 20) => queued(() => all("SELECT * FROM note_state WHERE state='pending' OR (state='error' AND coalesce(retry_after,0)<=?) ORDER BY coalesce(retry_after,0),note_id LIMIT ?", [now, limit])),
			publish: (note, revision, hash, values) => queued(() => tx(async () => {
				const row = await one('SELECT revision FROM note_state WHERE note_id=?', [note.id]); if (row?.revision !== revision) return false;
				if (values !== null) {
					await run('DELETE FROM chunks WHERE note_id=?', [note.id]);
					for (const chunk of values) {
						requireValue(chunk.vector.length === space.dimensions && chunk.vector.every(n => Number.isFinite(Math.fround(n))), 'invalid_embedding_response');
						const vector = Buffer.alloc(space.dimensions * 4); chunk.vector.forEach((n, i) => vector.writeFloatLE(n, i * 4));
						await run('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?)', [generation, note.id, chunk.ordinal, chunk.start, chunk.end, chunk.hash, space.dimensions, vector, chunk.text.slice(0, 320)]);
					}
				}
				await run("UPDATE note_state SET state='indexed',source_fingerprint=?,observed_fingerprint=?,source_updated_time=?,parent_id=?,error_code=NULL,retry_after=NULL WHERE note_id=?", [hash, hash, note.updated_time, note.parent_id, note.id]);
				return true;
			})),
			remove: id => queued(() => tx(async () => { await run('DELETE FROM chunks WHERE note_id=?', [identifier(id)]); await run("UPDATE note_state SET state='deleted',revision=revision+1,source_fingerprint=NULL,observed_fingerprint=NULL,parent_id=NULL,error_code=NULL,retry_after=NULL WHERE note_id=?", [id]); })),
			fail: (id, revision, code, retryAfter) => queued(() => run("UPDATE note_state SET state='error',error_code=?,retry_after=? WHERE note_id=? AND revision=?", [code, retryAfter, id, revision])),
			pause: (until, code) => queued(() => run('UPDATE runtime_state SET retry_after=?,last_error=?', [until, code])),
			usage: (tokens, bytes) => queued(() => run('UPDATE usage SET input_tokens=input_tokens+?,prepared_bytes=prepared_bytes+?,requests=requests+1', [tokens ?? 0, bytes])),
			// Exact, bounded-memory scan. Stored vectors never leave this process.
			/** Keep one best chunk for each matching note. The fourth argument optionally cancels the scan. */
			rank: (vector, limit = 100, notebookId, signal) => queued(() => rankVector(vector, { limit, notebookId, signal })),
			/**
			 * Return top individual chunks with optional notebook, note-ID, score, and cancellation filters.
			 * Each candidate preserves the rank fields and adds contentHash from the persisted chunk.
			 */
			rankChunks: (vector, { limit = 100, notebookId, noteIds, minScore = -1, signal } = {}) => queued(() => rankVector(vector, { limit, notebookId, noteIds, minScore, signal, byChunk: true })),
			async close() { if (closed) return; closed = true; await tail; try { await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); } finally { release(); } },
		});
	} catch (error) {
		key = undefined;
		if (db) await new Promise(resolve => db.close(() => resolve())); release();
		throw error instanceof ServiceError ? error : new ServiceError('semantic_store_unavailable', false, undefined, { cause: error });
	}
}
