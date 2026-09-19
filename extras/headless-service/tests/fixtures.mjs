import http from 'node:http';
import { once } from 'node:events';
export const noteId = 'a'.repeat(32);
export const folderId = 'b'.repeat(32);
export const space = { id: 'test-space-v1', revision: 'fake-weights-v1', dimensions: 2, preprocessingVersion: 'title-body-v1' };
export const note = { id: noteId, parent_id: folderId, title: 'Test', body: 'Unicode 笔记', updated_time: 100, markup_language: 1, encryption_applied: 0, deleted_time: 0, is_locked: 0 };
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
		async getNote() { return { ...note, body: id }; },
		async listNotes() { return { items: [{ ...note, body: id }], hasMore: false }; },
		async listNotebooks() { return { items: [{ id: folderId, title: id, parent_id: '' }], hasMore: false }; },
		async createNote(input) { return { ...note, title: input.title, body: input.body }; },
		async updateNote(_id, input) { return { ...note, ...input }; },
		async search() { return { items: [{ ...note, body: id }], hasMore: false }; },
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
