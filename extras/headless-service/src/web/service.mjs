import { createHash } from 'node:crypto';
import { requireValue, identifier, ServiceError, pagination } from '../errors.mjs';

export const MAX_BODY_BYTES = 262144;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const noteVersion = note => hash([note.id, note.parent_id, note.title, note.body, note.markup_language, note.updated_time]);
const summary = note => Object.fromEntries(['id', 'parent_id', 'title', 'updated_time', 'markup_language', 'accountId', 'provenance', 'rank', 'score'].filter(k => Object.hasOwn(note, k)).map(k => [k, note[k]]));
const matches = (note, input) => note.markup_language === 1 && note.title === input.title && note.body === input.body;
const editable = note => note.markup_language === 1 && typeof note.body === 'string' && Buffer.byteLength(note.body) <= MAX_BODY_BYTES && note.title.length <= 1024;

export function writeInput(input) {
	requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_web_write');
	requireValue(input.kind === 'create' || input.kind === 'update', 'invalid_web_write');
	const keys = input.kind === 'create' ? ['kind', 'operationId', 'notebookId', 'title', 'body'] : ['kind', 'operationId', 'noteId', 'baseVersion', 'title', 'body'];
	requireValue(Object.keys(input).every(k => keys.includes(k)), 'invalid_web_write');
	identifier(input.operationId);
	identifier(input.kind === 'create' ? input.notebookId : input.noteId);
	if (input.kind === 'update') requireValue(/^[a-f0-9]{64}$/.test(input.baseVersion ?? ''), 'invalid_base_version');
	requireValue(typeof input.title === 'string' && input.title.length <= 1024 && typeof input.body === 'string' && Buffer.byteLength(input.body) <= MAX_BODY_BYTES, 'invalid_web_content');
	return structuredClone(input);
}

/** One account-bound application service. Only this gateway's writes serialize;
 * stock-client/sync changes can race the preflight. This is explicitly NOT CAS. */
export function createWebService({ account, namespace, allowWrites = false, render }) {
	identifier(namespace);
	requireValue(account && typeof account.accountId === 'string' && typeof render === 'function');
	const queues = new Map();
	let outstandingWrites = 0;
	const view = note => ({ note, version: noteVersion(note), editable: allowWrites && editable(note), preview: render(note.body ?? '', note.markup_language), saved: 'local', synchronization: 'not_observed' });
	async function serial(id, run) {
		requireValue(outstandingWrites < 32, 'web_busy');
		outstandingWrites++;
		const previous = queues.get(id) ?? Promise.resolve();
		const pending = previous.catch(() => {}).then(run);
		queues.set(id, pending);
		try { return await pending; } finally { outstandingWrites--; if (queues.get(id) === pending) queues.delete(id); }
	}
	async function existing(id, signal) {
		try { return await account.getWebCreationRecord(id, signal); }
		catch (e) { if (e instanceof ServiceError && e.code === 'not_found') return null; throw e; }
	}
	return Object.freeze({
		async status(signal) {
			let core = 'reachable';
			try { await account.listNoteSummaries({ limit: 1 }, signal); } catch { core = 'unavailable'; }
			return { ...account.status(), allowWrites, core, synchronization: 'not_observed', maxBodyBytes: MAX_BODY_BYTES };
		},
		notebooks(options, signal) { return account.listNotebooks(pagination(options), signal); },
		notes(options = {}, signal) {
			const { notebookId, ...page } = options;
			if (notebookId !== undefined) identifier(notebookId);
			return account.listNoteSummaries({ ...pagination(page), ...(notebookId ? { notebookId } : {}) }, signal);
		},
		async get(id, signal) { return view(await account.getNote(identifier(id), signal)); },
		async search(input, signal) {
			requireValue(input && Object.keys(input).every(k => ['query', 'mode', 'page', 'limit'].includes(k)), 'invalid_search');
			const result = await account.search(input, signal);
			return { ...result, items: result.items.map(summary) };
		},
		preview(input) {
			requireValue(input && Object.keys(input).length === 1 && typeof input.body === 'string' && Buffer.byteLength(input.body) <= MAX_BODY_BYTES, 'invalid_preview');
			return { preview: render(input.body, 1) };
		},
		async write(value, signal) {
			requireValue(allowWrites, 'operation_not_permitted');
			const input = writeInput(value);
			const id = input.kind === 'update' ? input.noteId : hash(['joplin-web/v1', account.accountId, namespace, input.operationId]).slice(0, 32);
			return serial(id, async () => {
				if (signal?.aborted) throw new ServiceError('request_cancelled');
				let current;
				if (input.kind === 'create') {
					const receipt = `joplin-headless-web/v1:${hash(input)}`;
					let record = await existing(id, signal);
					if (!record) {
						await account.getNotebook(input.notebookId, signal);
						// The blank placeholder is intentionally visible after an interrupted create.
						await account.createWebPlaceholder({ id, parentId: input.notebookId, receipt }, signal);
						record = await existing(id, signal);
					}
					requireValue(record?.source === receipt && record.parent_id === input.notebookId && !record.deleted_time && !record.encryption_applied && !record.is_locked, 'web_creation_conflict');
					current = await account.getNote(id, signal);
					if (matches(current, input)) return { ...view(current), reconciled: true };
					requireValue(current.title === '[Pending web note]' && current.body === '' && current.markup_language === 1 && current.parent_id === input.notebookId, 'web_creation_conflict');
				} else {
					current = await account.getNote(id, signal);
					requireValue(editable(current), 'unsupported_note_format');
					// A lost PUT reply is reconciled by readable content, not an exactly-once claim.
					if (matches(current, input)) return { ...view(current), reconciled: true };
					requireValue(noteVersion(current) === input.baseVersion, 'stale_note');
				}
				await account.updateNote(id, { title: input.title, body: input.body }, signal);
				try {
					const saved = await account.getNote(id, signal);
					if (!matches(saved, input)) throw new ServiceError('write_outcome_unknown', true);
					return { ...view(saved), reconciled: false };
				} catch { throw new ServiceError('write_outcome_unknown', true); }
			});
		},
	});
}
