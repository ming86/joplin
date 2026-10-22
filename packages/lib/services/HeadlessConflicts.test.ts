import { ModelType } from '../BaseModel';
import Note from '../models/Note';
import Revision from '../models/Revision';
import HeadlessConflicts from './HeadlessConflicts';
import { NoteEntity } from './database/types';
import { setupDatabaseAndSynchronizer, switchClient } from '../testing/test-utils';

const noteId = (last: string): string => last.padStart(32, '0');

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

describe('services/HeadlessConflicts', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	it('filters and paginates active readable conflicts in stable update order', async () => {
		const [oldest, newestA, newestB, last] = [1, 2, 3, 4].map(id => noteId(String(id)));
		await saveNote(oldest, { is_conflict: 1, updated_time: 10 });
		await saveNote(newestA, { is_conflict: 1, updated_time: 20 });
		await saveNote(newestB, { is_conflict: 1, updated_time: 20 });
		await saveNote(last, { is_conflict: 1, updated_time: 5 });

		await saveNote(noteId('5'), { is_conflict: 1, deleted_time: 1 });
		await saveNote(noteId('6'), { is_conflict: 1, encryption_applied: 1 });
		await saveNote(noteId('7'), { is_conflict: 1, is_locked: 1 });
		await saveNote(noteId('8'));

		const firstPage = await HeadlessConflicts.listConflicts({ limit: 2 });
		expect(firstPage.items.map(item => item.id)).toEqual([newestA, newestB]);
		expect(firstPage.items[0]).toMatchObject({ title: `Note ${newestA}`, updated_time: 20, created_time: 100 });
		expect(firstPage.hasMore).toBe(true);

		const exactFinalPage = await HeadlessConflicts.listConflicts({ page: 2, limit: 2 });
		expect(exactFinalPage.items.map(item => item.id)).toEqual([oldest, last]);
		expect(exactFinalPage.hasMore).toBe(false);
	});

	it('reads paired native note snapshots without creating revisions', async () => {
		const originalId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const conflictId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
		await saveNote(originalId, {
			title: 'Original title',
			body: 'Original body',
			created_time: 123,
			updated_time: 234,
			is_todo: 1,
			todo_completed: 345,
			markup_language: 2,
			user_data: '{"private":true}',
			source_url: 'https://private.example',
		});
		await saveNote(conflictId, {
			title: 'Conflict title',
			body: 'Conflict body',
			created_time: 456,
			updated_time: 567,
			is_todo: 1,
			todo_completed: 678,
			markup_language: 3,
			is_conflict: 1,
			conflict_original_id: originalId,
			user_data: '{"private":true}',
			source_url: 'https://private.example',
		});

		const revisionCountsBefore = [originalId, conflictId].map(id => Revision.countRevisions(ModelType.Note, id));
		const before = await Promise.all(revisionCountsBefore);
		const listed = await HeadlessConflicts.listConflicts({});
		const result = await HeadlessConflicts.readConflict({ id: conflictId });
		const after = await Promise.all([originalId, conflictId].map(id => Revision.countRevisions(ModelType.Note, id)));

		expect(listed.items.map(item => item.id)).toContain(conflictId);
		expect(result.conflict).toEqual({
			id: conflictId,
			status: 'available',
			note: {
				id: conflictId,
				parent_id: '',
				title: 'Conflict title',
				body: 'Conflict body',
				created_time: 456,
				updated_time: 567,
				is_todo: 1,
				todo_completed: 678,
				markup_language: 3,
				is_conflict: 1,
				conflict_original_id: originalId,
			},
		});
		expect(result.original).toEqual({
			id: originalId,
			status: 'available',
			note: {
				id: originalId,
				parent_id: '',
				title: 'Original title',
				body: 'Original body',
				created_time: 123,
				updated_time: 234,
				is_todo: 1,
				todo_completed: 345,
				markup_language: 2,
				is_conflict: 0,
				conflict_original_id: '',
			},
		});
		expect(result.conflict.note).not.toHaveProperty('user_data');
		expect(result.conflict.note).not.toHaveProperty('source_url');
		expect(after).toEqual(before);
	});

	it('reports missing, trashed, encrypted, locked, and unlinked originals without note data', async () => {
		const cases: { conflictId: string; originalId: string; status: string; original?: Partial<NoteEntity> }[] = [
			{ conflictId: noteId('20'), originalId: noteId('30'), status: 'missing' },
			{ conflictId: noteId('21'), originalId: noteId('31'), status: 'trashed', original: { deleted_time: 1 } },
			{ conflictId: noteId('22'), originalId: noteId('32'), status: 'encrypted', original: { encryption_applied: 1 } },
			{ conflictId: noteId('23'), originalId: noteId('33'), status: 'locked', original: { is_locked: 1 } },
		];
		for (const item of cases) {
			await saveNote(item.conflictId, { is_conflict: 1, conflict_original_id: item.originalId });
			if (item.original) await saveNote(item.originalId, item.original);
			const result = await HeadlessConflicts.readConflict({ id: item.conflictId });
			expect(result.original).toEqual({ id: item.originalId, status: item.status });
		}

		const unlinkedId = noteId('24');
		await saveNote(unlinkedId, { is_conflict: 1, conflict_original_id: '' });
		expect(await HeadlessConflicts.readConflict({ id: unlinkedId })).toMatchObject({
			original: { id: null, status: 'unlinked' },
		});
	});

	it('reports unavailable states for an existing conflict copy and rejects missing or ordinary notes', async () => {
		const [trashedId, encryptedId, lockedId, ordinaryId] = [40, 41, 42, 43].map(id => noteId(String(id)));
		await saveNote(trashedId, { is_conflict: 1, deleted_time: 1 });
		await saveNote(encryptedId, { is_conflict: 1, encryption_applied: 1 });
		await saveNote(lockedId, { is_conflict: 1, is_locked: 1 });
		await saveNote(ordinaryId);

		for (const [id, status] of [[trashedId, 'trashed'], [encryptedId, 'encrypted'], [lockedId, 'locked']] as const) {
			expect(await HeadlessConflicts.readConflict({ id })).toEqual({ conflict: { id, status }, original: { id: null, status: 'unlinked' } });
		}
		await expect(HeadlessConflicts.readConflict({ id: noteId('44') })).rejects.toMatchObject({ code: 'conflict_not_found' });
		await expect(HeadlessConflicts.readConflict({ id: ordinaryId })).rejects.toMatchObject({ code: 'conflict_not_found' });
	});

	it('returns stable invalid-input errors for malformed requests and pagination', async () => {
		await expect(HeadlessConflicts.readConflict({ id: 'bad' })).rejects.toMatchObject({ code: 'invalid_conflict_input' });
		await expect(HeadlessConflicts.readConflict({ id: noteId('50'), unsupported: true } as never)).rejects.toMatchObject({ code: 'invalid_conflict_input' });
		await expect(HeadlessConflicts.listConflicts({ page: 0 })).rejects.toMatchObject({ code: 'invalid_conflict_input' });
		await expect(HeadlessConflicts.listConflicts({ limit: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: 'invalid_conflict_input' });
	});
});
