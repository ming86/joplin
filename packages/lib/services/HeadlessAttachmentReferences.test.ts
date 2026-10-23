import HeadlessAttachmentReferences from './HeadlessAttachmentReferences';
import { NoteEntity } from './database/types';
import { setupDatabaseAndSynchronizer, switchClient } from '../testing/test-utils';
import Note from '../models/Note';

const noteId = (last: string): string => last.padStart(32, '0');
const attachmentId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const saveNote = async (id: string, values: Partial<NoteEntity> = {}): Promise<NoteEntity> => Note.save({
	id,
	parent_id: '',
	title: `Note ${id}`,
	body: `Body ${id}`,
	created_time: 100,
	updated_time: 100,
	is_todo: 0,
	todo_completed: 0,
	markup_language: 1,
	is_conflict: 0,
	conflict_original_id: '',
	deleted_time: 0,
	encryption_applied: 0,
	is_locked: 0,
	...values,
}, { isNew: true, autoTimestamp: false });

describe('services/HeadlessAttachmentReferences', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	it('finds references in current saved bodies after create, edit, and removal without indexing', async () => {
		const id = noteId('1');
		await saveNote(id, { body: `A link [file](:/${attachmentId})` });

		const created = await HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId });
		expect(created.items.map(item => item.id)).toEqual([id]);

		await Note.save({ id, body: `![image](:/${attachmentId})` });
		const edited = await HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId });
		expect(edited.items.map(item => item.id)).toEqual([id]);

		await Note.save({ id, body: 'The attachment link was removed.' });
		const removed = await HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId });
		expect(removed.items).toEqual([]);
		expect(removed.hasMore).toBe(false);
	});

	it('uses native link parsing, collapses repeated references, and includes trash and conflicts', async () => {
		const markdownId = noteId('1');
		const whiteboardId = noteId('2');
		const trashedId = noteId('3');
		const conflictId = noteId('4');
		const unreadableId = noteId('5');
		const lockedId = noteId('6');
		const canvas = `\`\`\`jsoncanvas\n${JSON.stringify({
			nodes: [
				{ id: 'a', type: 'file', x: 0, y: 0, width: 100, height: 100, file: `:/${attachmentId}` },
				{ id: 'b', type: 'file', x: 0, y: 0, width: 100, height: 100, file: `:/${attachmentId}` },
			],
			edges: [],
		})}\n\`\`\``;
		await saveNote(markdownId, {
			body: `[file](:/${attachmentId}) ![same file](:/${attachmentId})`,
			user_data: '{"private":true}',
		});
		await saveNote(whiteboardId, { body: canvas });
		await saveNote(trashedId, { body: `[](:/${attachmentId})`, deleted_time: 200 });
		await saveNote(conflictId, { body: `[](:/${attachmentId})`, is_conflict: 1 });
		await saveNote(unreadableId, { body: `[](:/${attachmentId})`, encryption_applied: 1 });
		await saveNote(lockedId, { body: `[](:/${attachmentId})`, is_locked: 1 });

		const result = await HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId });
		expect(result.items.map(item => item.id)).toEqual([markdownId, whiteboardId, trashedId, conflictId]);
		expect(result.items[0]).toEqual({
			id: markdownId,
			title: `Note ${markdownId}`,
			parent_id: '',
			created_time: 100,
			updated_time: 100,
			deleted_time: 0,
			is_conflict: 0,
		});
		expect(result.items[2]).toMatchObject({ id: trashedId, deleted_time: 200, is_conflict: 0 });
		expect(result.items[3]).toMatchObject({ id: conflictId, deleted_time: 0, is_conflict: 1 });
		expect(result.items[0]).not.toHaveProperty('body');
		expect(result.items[0]).not.toHaveProperty('user_data');
	});

	it('paginates stable matches and reports an exact final page', async () => {
		const ids = [noteId('1'), noteId('2'), noteId('3')];
		for (const id of ids) await saveNote(id, { body: `[file](:/${attachmentId})` });

		const first = await HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId, limit: 2 });
		expect(first.items.map(item => item.id)).toEqual(ids.slice(0, 2));
		expect(first.hasMore).toBe(true);

		const final = await HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId, page: 2, limit: 2 });
		expect(final.items.map(item => item.id)).toEqual([ids[2]]);
		expect(final.hasMore).toBe(false);

		const afterEnd = await HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId, page: 3, limit: 2 });
		expect(afterEnd.items).toEqual([]);
		expect(afterEnd.hasMore).toBe(false);
	});

	it('rejects malformed IDs, unsupported fields, and unsafe pagination', async () => {
		await expect(HeadlessAttachmentReferences.listAttachmentNotes({ id: 'bad' }))
			.rejects.toMatchObject({ code: 'invalid_attachment_reference_input' });
		await expect(HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId, extra: true } as never))
			.rejects.toMatchObject({ code: 'invalid_attachment_reference_input' });
		await expect(HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId, page: 0 }))
			.rejects.toMatchObject({ code: 'invalid_attachment_reference_input' });
		await expect(HeadlessAttachmentReferences.listAttachmentNotes({ id: attachmentId, limit: Number.MAX_SAFE_INTEGER }))
			.rejects.toMatchObject({ code: 'invalid_attachment_reference_input' });
	});
});
