import { createHash } from 'node:crypto';
import { ServiceError, requireValue, identifier } from '../errors.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const receiptPrefix = 'joplin-headless-clip/v1:';

export function literalMarkdown(text) {
	// Entities are decoded as text by Markdown, not reparsed as image/HTML syntax.
	return text.replace(/&/g, '&amp;').replace(/[\\`*_{}\[\]()#+\-.!|~<>]/g, c => `&#${c.codePointAt(0)};`);
}
export function clipInput(value) {
	requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid_clip');
	requireValue(Object.keys(value).every(k => ['operationId', 'notebookId', 'title', 'text', 'sourceUrl'].includes(k)), 'invalid_clip');
	identifier(value.operationId); identifier(value.notebookId);
	for (const [key, limit] of [['title', 512], ['text', 131072], ['sourceUrl', 4096]]) {
		requireValue(typeof value[key] === 'string' && value[key].trim().length > 0 && Buffer.byteLength(value[key]) <= limit && !value[key].includes('\0') && value[key].isWellFormed(), 'invalid_clip');
	}
	requireValue(!/[\r\n]/.test(value.title), 'invalid_clip');
	let url; try { url = new URL(value.sourceUrl); } catch { throw new ServiceError('invalid_clip_source'); }
	requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'invalid_clip_source');
	url.hash = ''; // Page anchors are not needed; query strings remain caller-visible for review.
	return { operationId: value.operationId, notebookId: value.notebookId, title: value.title, text: value.text.replace(/\r\n?/g, '\n'), sourceUrl: url.href };
}

// One instance is bound to one configured Joplin account. Authentication selects
// this instance, never a caller-supplied account, upstream URL or arbitrary note ID.
export function createClipService({ accountId, namespace, notebookIds, backend }) {
	requireValue(typeof accountId === 'string' && /^[\w-]{1,64}$/.test(accountId));
	identifier(namespace);
	requireValue(Array.isArray(notebookIds) && notebookIds.length > 0 && notebookIds.length <= 50 && new Set(notebookIds).size === notebookIds.length);
	notebookIds.forEach(identifier); const allowed = new Set(notebookIds); const active = new Map();
	async function existing(id, receipt, notebookId, signal) {
		let record;
		try { record = await backend.getClipRecord(id, signal); } catch (error) { if (error.code === 'not_found') return null; throw error; }
		if (record.source !== receipt || record.parent_id !== notebookId || record.deleted_time || record.is_locked || record.encryption_applied !== 0) throw new ServiceError('clip_operation_conflict');
		return { noteId: id, replayed: true, saved: 'local', synchronization: 'not_confirmed' };
	}
	return Object.freeze({
		async notebooks(signal) {
			const items = [];
			for (const id of allowed) items.push(await backend.getNotebook(id, signal));
			return { items };
		},
		async submit(value, signal) {
			const input = clipInput(value);
			requireValue(allowed.has(input.notebookId), 'clip_notebook_not_permitted');
			const id = hash(JSON.stringify(['joplin-clip-v1', accountId, namespace, input.operationId])).slice(0, 32);
			const receipt = receiptPrefix + hash(JSON.stringify([input.notebookId, input.title, input.text, input.sourceUrl]));
			if (active.has(id)) {
				const job = active.get(id);
				if (job.receipt !== receipt) throw new ServiceError('clip_operation_conflict');
				return { ...await job.promise, replayed: true };
			}
			requireValue(active.size < 16, 'clip_busy');
			const promise = (async () => {
				const previous = await existing(id, receipt, input.notebookId, signal);
				if (previous) return previous;
				await backend.getNotebook(input.notebookId, signal);
				const body = `${literalMarkdown(input.text)}\n\nSource: ${literalMarkdown(input.sourceUrl)}\n`;
				try {
					// The Joplin POST path saves explicit IDs with isNew=true. A duplicate
					// is not an update; never issue PUT to reconcile a create.
					await backend.createClipRecord({ id, parent_id: input.notebookId, title: input.title, body, source: receipt, source_url: input.sourceUrl }, signal);
				} catch (error) {
					if (!signal?.aborted) {
						const observed = await existing(id, receipt, input.notebookId, signal);
						if (observed) return observed;
					}
					throw new ServiceError('clip_outcome_unknown', true);
				}
				return { noteId: id, replayed: false, saved: 'local', synchronization: 'not_confirmed' };
			})();
			active.set(id, { receipt, promise });
			try { return await promise; } finally { active.delete(id); }
		},
	});
}
