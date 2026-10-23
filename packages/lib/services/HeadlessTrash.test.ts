import BaseItem from '../models/BaseItem';
import Folder from '../models/Folder';
import Note from '../models/Note';
import HeadlessTrash from './HeadlessTrash';
import { FolderEntity, NoteEntity } from './database/types';
import { setupDatabaseAndSynchronizer, switchClient } from '../testing/test-utils';

const itemId = (last: string): string => last.padStart(32, '0');

/** Save a native note fixture without letting the current clock change its timestamps. */
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

/** Save a native notebook fixture without letting the current clock change its timestamps. */
const saveNotebook = async (id: string, values: Partial<FolderEntity> = {}): Promise<FolderEntity> => Folder.save({
	id,
	parent_id: '',
	title: `Notebook ${id}`,
	created_time: 100,
	updated_time: 100,
	deleted_time: 0,
	encryption_applied: 0,
	...values,
}, { isNew: true, autoTimestamp: false });

describe('services/HeadlessTrash', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	it('lists notes and notebooks in stable mixed order with exact hasMore pagination', async () => {
		const [noteA, noteB, notebookA, notebookB] = ['1', '2', '3', '4'].map(itemId);
		await saveNote(noteB, { deleted_time: 300, updated_time: 11 });
		await saveNote(noteA, { deleted_time: 300, updated_time: 12 });
		await saveNotebook(notebookB, { deleted_time: 300, updated_time: 13 });
		await saveNotebook(notebookA, { deleted_time: 300, updated_time: 14 });
		await saveNote(itemId('5'), { deleted_time: 0 });
		await saveNotebook(itemId('6'), { deleted_time: 0 });

		const firstPage = await HeadlessTrash.listTrash({ limit: 2 });
		expect(firstPage.items.map(item => [item.type, item.id])).toEqual([
			['note', noteA],
			['note', noteB],
		]);
		expect(firstPage.hasMore).toBe(true);

		const exactFinalPage = await HeadlessTrash.listTrash({ page: 2, limit: 2 });
		expect(exactFinalPage.items.map(item => [item.type, item.id])).toEqual([
			['notebook', notebookA],
			['notebook', notebookB],
		]);
		expect(exactFinalPage.hasMore).toBe(false);
	});

	it('includes trashed encrypted, locked, and conflict notes while masking encrypted titles', async () => {
		const encryptedConflictId = itemId('10');
		const lockedConflictId = itemId('11');
		await saveNote(encryptedConflictId, {
			title: 'Private encrypted title',
			deleted_time: 100,
			encryption_applied: 1,
			is_locked: 1,
			is_conflict: 1,
		});
		await saveNote(lockedConflictId, {
			title: 'Locked conflict title',
			deleted_time: 100,
			is_locked: 1,
			is_conflict: 1,
		});

		const result = await HeadlessTrash.listTrash({});
		const encrypted = result.items.find(item => item.id === encryptedConflictId);
		const locked = result.items.find(item => item.id === lockedConflictId);
		expect(encrypted).toMatchObject({
			type: 'note',
			title: BaseItem.displayTitle({ title: 'Private encrypted title', encryption_applied: 1 }),
			is_conflict: 1,
		});
		expect(encrypted.title).not.toContain('Private encrypted title');
		expect(locked).toMatchObject({ type: 'note', title: 'Locked conflict title', is_conflict: 1 });
	});

	it('restores a note to its valid parent and to the root when its parent is missing', async () => {
		const parentId = itemId('20');
		const childId = itemId('21');
		const orphanId = itemId('22');
		await saveNotebook(parentId);
		await saveNote(childId, { parent_id: parentId, deleted_time: 100 });
		await saveNote(orphanId, { parent_id: itemId('23'), deleted_time: 100 });

		expect(await HeadlessTrash.restoreNote({ id: childId })).toEqual({ id: childId, parent_id: parentId, restored: true });
		expect(await Note.load(childId, { fields: ['deleted_time', 'parent_id'] })).toMatchObject({ deleted_time: 0, parent_id: parentId });
		expect(await HeadlessTrash.restoreNote({ id: orphanId })).toEqual({ id: orphanId, parent_id: '', restored: true });
		expect(await Note.load(orphanId, { fields: ['deleted_time', 'parent_id'] })).toMatchObject({ deleted_time: 0, parent_id: '' });
	});

	it('restores a notebook and deleted descendants through the native subtree restore', async () => {
		const parentId = itemId('30');
		const rootId = itemId('31');
		const childFolderId = itemId('32');
		const childNoteId = itemId('33');
		await saveNotebook(parentId);
		await saveNotebook(rootId, { parent_id: parentId, deleted_time: 100 });
		await saveNotebook(childFolderId, { parent_id: rootId, deleted_time: 100 });
		await saveNote(childNoteId, { parent_id: childFolderId, deleted_time: 100 });

		expect(await HeadlessTrash.restoreNotebook({ id: rootId })).toEqual({ id: rootId, parent_id: parentId, restored: true });
		expect(await Folder.load(rootId, { fields: ['deleted_time'] })).toMatchObject({ deleted_time: 0 });
		expect(await Folder.load(childFolderId, { fields: ['deleted_time'] })).toMatchObject({ deleted_time: 0 });
		expect(await Note.load(childNoteId, { fields: ['deleted_time'] })).toMatchObject({ deleted_time: 0 });
	});

	it('rejects an active target before native restore mutation', async () => {
		const activeNoteId = itemId('40');
		await saveNote(activeNoteId);

		await expect(HeadlessTrash.restoreNote({ id: activeNoteId })).rejects.toMatchObject({ code: 'trash_item_not_deleted' });
		expect(await Note.load(activeNoteId, { fields: ['deleted_time'] })).toMatchObject({ deleted_time: 0 });
	});

	it('returns stable errors for malformed listing and restore requests', async () => {
		await expect(HeadlessTrash.listTrash({ page: Number.MAX_SAFE_INTEGER, limit: 2 })).rejects.toMatchObject({ code: 'invalid_trash_input' });
		await expect(HeadlessTrash.restoreNote({ id: 'bad' })).rejects.toMatchObject({ code: 'invalid_trash_input' });
		await expect(HeadlessTrash.restoreNotebook({ id: itemId('50') })).rejects.toMatchObject({ code: 'trash_item_not_found' });
		await expect(HeadlessTrash.listTrash({ unknown: true } as never)).rejects.toMatchObject({ code: 'invalid_trash_input' });
	});
});
