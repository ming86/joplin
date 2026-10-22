import { createAccountRegistry } from '../index.mjs';
import { ServiceError } from '../src/errors.mjs';
import { createWebService } from '../src/web/service.mjs';
import { createMarkdownRenderer } from '../src/web/render.mjs';
import { account as config, headlessStatus, note, folderId } from './fixtures.mjs';
export const namespace = 'c'.repeat(32);
export const newWrite = (body = '# Test\nUnicode 笔记', operationId = 'd'.repeat(32)) => ({ kind: 'create', operationId, notebookId: folderId, title: 'Browser test', body });
export function webFixture({ allowWrites = true, render = body => body, records = [note], makeSemanticBackend } = {}) {
	const notes = new Map(records.map(n => [n.id, { ...n }]));
	const writes = [];
	const hooks = { afterPlaceholder: null, afterUpdate: null, beforeUpdate: null };
	const backend = {
		async status() { return structuredClone(headlessStatus); },
		async getNote(id) { const n = notes.get(id); if (!n) throw new ServiceError('not_found'); return { ...n }; },
		async getClipRecord(id) { const n = await this.getNote(id); return { ...n, source: n.source ?? '' }; },
		async getNotebook(id) { if (id !== folderId) throw new ServiceError('not_found'); return { id, title: 'Notebook' }; },
		async listNotebooks() { return { items: [{ id: folderId, title: 'Notebook', parent_id: '' }], hasMore: false }; },
		async listNoteSummaries({ notebookId } = {}) {
			return { items: [...notes.values()].filter(n => !notebookId || n.parent_id === notebookId).map(({ body, source, ...n }) => n), hasMore: false };
		},
		async createWebPlaceholder(input) {
			writes.push({ method: 'POST', input: structuredClone(input) });
			if (notes.has(input.id)) throw new ServiceError('backend_request_failed');
			notes.set(input.id, { ...note, id: input.id, parent_id: input.parentId, title: '[Pending web note]', body: '', source: input.receipt });
			await hooks.afterPlaceholder?.(notes.get(input.id)); return { id: input.id };
		},
		async updateNote(id, input) {
			await hooks.beforeUpdate?.(); writes.push({ method: 'PUT', input: structuredClone(input) });
			const n = notes.get(id); Object.assign(n, input); n.updated_time++;
			await hooks.afterUpdate?.(n); return { ...n };
		},
		async search(query) { return { items: [...notes.values()].filter(n => (n.title + n.body).includes(query)), hasMore: false }; },
	};
	const c = config(); c.permissions = allowWrites ? ['read', 'write'] : ['read'];
	const registry = createAccountRegistry([c], { makeBackend: () => backend, makeSemanticBackend });
	const account = registry.forPrincipal('alice', 'alice');
	const service = () => createWebService({ account, namespace, allowWrites, render });
	return { account, backend, notes, writes, hooks, service: service(), restart: service };
}
export function realRender() { return createMarkdownRenderer(process.env.JOPLIN_WEB_MARKDOWN_MODULE); }
