import http from 'node:http';
import { once } from 'node:events';
import { ServiceError } from '../src/errors.mjs';
export const noteId = 'a'.repeat(32);
export const folderId = 'b'.repeat(32);
export const initialRevisionId = '0'.repeat(31) + '1';
export const space = { id: 'test-space-v1', revision: 'fake-weights-v1', dimensions: 2, preprocessingVersion: 'title-body-v1' };
export const note = { id: noteId, parent_id: folderId, title: 'Test', body: 'Unicode 笔记', created_time: 50, updated_time: 100, is_todo: 0, todo_completed: 0, markup_language: 1, encryption_applied: 0, deleted_time: 0, is_locked: 0 };
export const headlessStatus = {
	accountEmail: 'alice@example.test',
	observedAt: 1000,
	serviceStartedAt: 900,
	sync: { running: false, pending: false, kind: null, lastPeriodicFullSync: null, report: null },
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
	let revisionSequence = 2n;
	let currentRevisionId = initialRevisionId;
	const tagsByTitle = new Map();
	return {
		async status() { return structuredClone(headlessStatus); },
		async getNote() { return { ...note, body: id }; },
		async readNoteWithRevision(noteId, signal) {
			const current = await this.getNote(noteId, signal);
			return { ...current, revision_id: currentRevisionId };
		},
		async updateNoteWithRevision(noteId, input, signal) {
			const current = await this.readNoteWithRevision(noteId, signal);
			if (current.encryption_applied !== 0 || current.deleted_time || current.is_locked) {
				throw new ServiceError('note_unavailable');
			}
			if (input.base_revision_id !== current.revision_id) {
				throw new ServiceError('note_conflict');
			}
			const { base_revision_id, ...changes } = input;
			const patch = {};
			if (Object.hasOwn(changes, 'title')) patch.title = changes.title;
			if (Object.hasOwn(changes, 'notebook_id')) patch.parentId = changes.notebook_id;
			if (Object.hasOwn(changes, 'todo_completed')) patch.todo_completed = changes.todo_completed ? 1234 : 0;
			if (Object.hasOwn(changes, 'body')) patch.body = changes.body;
			else {
				let updatedBody = current.body ?? '';
				if (Object.hasOwn(changes, 'prepend')) updatedBody = changes.prepend + updatedBody;
				if (Object.hasOwn(changes, 'append')) updatedBody += changes.append;
				if (Object.hasOwn(changes, 'replace_text')) {
					const { find, replace } = changes.replace_text;
					const first = updatedBody.indexOf(find);
					const second = updatedBody.indexOf(find, first + find.length);
					if (first < 0) {
						throw new ServiceError('replace_text_not_found');
					}
					if (second >= 0) {
						throw new ServiceError('replace_text_ambiguous');
					}
					updatedBody = updatedBody.slice(0, first) + replace + updatedBody.slice(first + find.length);
				}
				if (Object.hasOwn(changes, 'prepend') || Object.hasOwn(changes, 'append') || Object.hasOwn(changes, 'replace_text')) patch.body = updatedBody;
			}
			const result = await this.updateNote(noteId, patch, signal);
			const previous_revision_id = current.revision_id;
			const revision_id = (revisionSequence++).toString(16).padStart(32, '0');
			currentRevisionId = revision_id;
			return { ...result, revision_id, previous_revision_id, changed: true };
		},
		async listNotes() { return { items: [{ ...note, body: id }], hasMore: false }; },
		async listNoteSummaries() {
			const summary = { ...note };
			delete summary.body;
			return { items: [summary], hasMore: false };
		},
		/** Report the fixture note only while it is active and eligible for counts. */
		async notebookNoteCounts() {
			if (note.encryption_applied !== 0 || note.deleted_time || note.is_locked || note.is_conflict) return {};
			return { [note.parent_id]: 1 };
		},
		async listNotebooks() { return { items: [{ id: folderId, title: id, parent_id: '' }], hasMore: false }; },
		async listTrash() {
			return {
				items: [{ id: noteId, type: 'note', title: note.title, parent_id: folderId, deleted_time: 10, updated_time: note.updated_time, is_conflict: 0 }],
				hasMore: false,
			};
		},
		async restoreNote({ id: restoredId }) { return { id: restoredId, parent_id: folderId, restored: true }; },
		async restoreNotebook({ id: restoredId }) { return { id: restoredId, parent_id: '', restored: true }; },
		async listAllNotebooks() { return [{ id: folderId, title: id, parent_id: null }]; },
		async getNotebook(notebookId) { return { id: notebookId, title: notebookId === folderId ? id : 'Moved notebook', parent_id: null }; },
		async getNoteTags() { return []; },
		async listAttachmentNotes() {
			return {
				attachment_id: 'e'.repeat(32),
				items: [{ id: noteId, title: note.title, parent_id: folderId, created_time: note.created_time, updated_time: note.updated_time, deleted_time: 0, is_conflict: 0 }],
				hasMore: false,
			};
		},
		async listAllTags() { return []; },
		/** Return a committed creation snapshot with its first monotonically numbered revision. */
		async createNoteWithRevision(input) {
			const revision_id = (revisionSequence++).toString(16).padStart(32, '0');
			currentRevisionId = revision_id;
			const parent_id = input.notebook_id ?? input.parentId ?? folderId;
			return {
				...note,
				id: noteId,
				parent_id,
				notebook_id: parent_id,
				title: input.title,
				body: input.body ?? '',
				updated_time: 101,
				revision_id,
			};
		},
		async createNote(input) { return { ...note, parent_id: input.parentId, title: input.title, body: input.body, is_todo: input.is_todo }; },
		async updateNote(_id, input) { return { ...note, ...input, parent_id: input.parentId ?? note.parent_id, updated_time: 101 }; },
		async deleteNote() {},
		async createNotebook(input) { return { id: 'c'.repeat(32), title: input.title, parent_id: input.parentId ?? null }; },
		async findTagByTitle(title) { return tagsByTitle.get(title) ?? null; },
		async createTag(title) {
			const tag = { id: 'd'.repeat(32), title };
			tagsByTitle.set(title, tag);
			return tag;
		},
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
