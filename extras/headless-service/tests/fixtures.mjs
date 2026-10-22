import http from 'node:http';
import { once } from 'node:events';
export const noteId = 'a'.repeat(32);
export const folderId = 'b'.repeat(32);
export const space = { id: 'test-space-v1', revision: 'fake-weights-v1', dimensions: 2, preprocessingVersion: 'title-body-v1' };
export const note = { id: noteId, parent_id: folderId, title: 'Test', body: 'Unicode 笔记', created_time: 50, updated_time: 100, is_todo: 0, todo_completed: 0, markup_language: 1, encryption_applied: 0, deleted_time: 0, is_locked: 0 };
export const headlessStatus = {
	observedAt: 1000,
	serviceStartedAt: 900,
	sync: { running: false, pending: false, report: null },
	decryption: { state: 'idle', batch: null, missingMasterKey: false, disabledItemCount: 0 },
};
export function account(id = 'alice') {
	return {
		id, subjects: [id], permissions: ['read', 'write'],
		joplin: { baseUrl: `http://127.0.0.1:${id === 'alice' ? 41185 : 41186}`, token: `${id}-private-token` },
		semantic: { databasePath: `/tmp/headless-contracts/${id}/semantic.db`, keyRef: `${id}/semantic-key` },
		embedding: { protocol: 'openai-embeddings', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fake-model', remoteProcessing: false, space: { ...space } },
	};
}
export function backend(id = 'alice') {
	return {
		async status() { return structuredClone(headlessStatus); },
		async getNote() { return { ...note, body: id }; },
		async listNotes() { return { items: [{ ...note, body: id }], hasMore: false }; },
		async listNoteSummaries() {
			const summary = { ...note };
			delete summary.body;
			return { items: [summary], hasMore: false };
		},
		async listNotebooks() { return { items: [{ id: folderId, title: id, parent_id: '' }], hasMore: false }; },
		async listAllNotebooks() { return [{ id: folderId, title: id, parent_id: null }]; },
		async getNotebook(notebookId) { return { id: notebookId, title: notebookId === folderId ? id : 'Moved notebook', parent_id: null }; },
		async getNoteTags() { return []; },
		async listAllTags() { return []; },
		async createNote(input) { return { ...note, parent_id: input.parentId, title: input.title, body: input.body, is_todo: input.is_todo }; },
		async updateNote(_id, input) { return { ...note, ...input, parent_id: input.parentId ?? note.parent_id, updated_time: 101 }; },
		async deleteNote() {},
		async createNotebook(input) { return { id: 'c'.repeat(32), title: input.title, parent_id: input.parentId ?? null }; },
		async createTag(title) { return { id: 'd'.repeat(32), title }; },
		async addTagToNote() {},
		async removeTagFromNote() {},
		async search() { return { items: [{ ...note, body: id }], hasMore: false }; },
		async countSearchResults() { return 1; },
		async changes() { return { cursor: '1', items: [], hasMore: false }; },
	};
}
export async function server(t, handler) {
	const instance = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => { res.destroy(); }));
	instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
	t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
	return `http://127.0.0.1:${instance.address().port}`;
}
export async function readJson(req) { const parts = []; for await (const part of req) parts.push(part); return JSON.parse(Buffer.concat(parts)); }
