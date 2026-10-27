import Note from '../models/Note';
import Revision from '../models/Revision';
import Folder from '../models/Folder';
import Setting from '../models/Setting';
import { ModelType } from '../BaseModel';
import HeadlessRevisionHistory, { ListRevisionsRequest } from './HeadlessRevisionHistory';
import { setupDatabaseAndSynchronizer, switchClient } from '../testing/test-utils';

describe('services/HeadlessRevisionHistory', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	it('lists global summaries in timestamp and ID order with bounds and exact-page lookahead', async () => {
		const note = await Note.save({ title: 'Current title', body: 'Historical body' });
		const first = await Note.revisionService().createNoteRevision_(note, null, true);
		const secondNote = await Note.save({ title: 'Second note' });
		const second = await Note.revisionService().createNoteRevision_(secondNote, null, true);
		const third = await Revision.save({ item_type: ModelType.Note, item_id: note.id, item_updated_time: 200, parent_id: first.id });
		await Revision.db().exec('UPDATE revisions SET encryption_applied = 1 WHERE id = ?', [third.id]);
		await Revision.save({ id: first.id, item_updated_time: 100 });
		await Revision.save({ id: second.id, item_updated_time: 200 });
		const expected = [second.id, third.id].sort().reverse();
		const capture = jest.spyOn(Note.revisionService(), 'createNoteRevision_');
		const reconstruct = jest.spyOn(Revision, 'mergeDiffsStrict');
		try {
			const all = await HeadlessRevisionHistory.listRevisions({ limit: 101 });
			expect(all).toMatchObject({ page: 1, limit: 101, hasMore: false });
			expect(all.items.find(item => item.note_id === note.id)).toMatchObject({ current_title: note.title, current_notebook_id: null });
			expect(all.items.map(item => item.revision_id)).toEqual([...expected, first.id]);
			const page = await HeadlessRevisionHistory.listRevisions({ since: 200, until: 201, limit: 2 });
			expect(page.items.map(item => item.revision_id)).toEqual(expected);
			expect(page.hasMore).toBe(false);
			expect((await HeadlessRevisionHistory.listRevisions({ until: 200 })).items.map(item => item.revision_id)).toEqual([first.id]);
			expect((await HeadlessRevisionHistory.listRevisions({ since: 200, until: 200 })).items).toEqual([]);
			expect((await HeadlessRevisionHistory.listRevisions({ since: 201, until: 100 })).items).toEqual([]);
			expect((await HeadlessRevisionHistory.listRevisions({ limit: 2 })).hasMore).toBe(true);
			expect((await HeadlessRevisionHistory.listRevisions({ limit: 2, page: 2 })).items.map(item => item.revision_id)).toEqual([first.id]);
			expect(capture).not.toHaveBeenCalled();
			expect(reconstruct).not.toHaveBeenCalled();
		} finally {
			capture.mockRestore();
			reconstruct.mockRestore();
		}
		const selected = (await HeadlessRevisionHistory.listRevisions({ note_ids: [note.id], until: 200 })).items[0];
		expect(await HeadlessRevisionHistory.readNoteRevision(selected)).toMatchObject({ title: note.title });
		expect(await HeadlessRevisionHistory.compareNoteRevisions({ note_id: note.id, from_revision_id: selected.revision_id, to_revision_id: selected.revision_id })).toMatchObject({ title_diff: '', body_diff: '' });
	});

	it('unions selectors using current readable notebook membership, descendants and explicit empty scopes', async () => {
		const source = await Folder.save({ title: 'Source' });
		const destination = await Folder.save({ title: 'Destination' });
		const child = await Folder.save({ title: 'Child', parent_id: destination.id });
		const moved = await Note.save({ title: 'Moved', parent_id: source.id });
		const movedRevision = await Note.revisionService().createNoteRevision_(moved, null, true);
		await Note.save({ id: moved.id, parent_id: destination.id, title: 'Current moved title' });
		const nested = await Note.save({ title: 'Nested', parent_id: child.id });
		const nestedRevision = await Note.revisionService().createNoteRevision_(nested, null, true);
		const sourceRows = await HeadlessRevisionHistory.listRevisions({ notebook_ids: [source.id] });
		expect(sourceRows.items).toEqual([]);
		const destinationRows = await HeadlessRevisionHistory.listRevisions({ notebook_ids: [destination.id] });
		expect(destinationRows.items.map(item => item.revision_id).sort()).toEqual([movedRevision.id, nestedRevision.id].sort());
		expect(destinationRows.items.find(item => item.note_id === moved.id)).toMatchObject({ current_title: 'Current moved title', current_notebook_id: destination.id });
		expect((await HeadlessRevisionHistory.listRevisions({ notebook_ids: [destination.id], include_descendants: false })).items.map(item => item.revision_id)).toEqual([movedRevision.id]);
		expect((await HeadlessRevisionHistory.listRevisions({ note_ids: [moved.id, moved.id], notebook_ids: [destination.id] })).items).toHaveLength(2);
		expect((await HeadlessRevisionHistory.listRevisions({ note_ids: [moved.id], notebook_ids: [child.id] })).items).toHaveLength(2);
		const emptyScopes: ListRevisionsRequest[] = [{ note_ids: [] }, { notebook_ids: [] }, { note_ids: [], notebook_ids: [] }];
		for (const request of emptyScopes) {
			expect((await HeadlessRevisionHistory.listRevisions(request)).items).toEqual([]);
		}
		await expect(HeadlessRevisionHistory.listRevisions({ notebook_ids: ['0'.repeat(32)] })).rejects.toMatchObject({ code: 'notebook_unavailable' });
		await Folder.db().exec('UPDATE folders SET encryption_applied = 1 WHERE id = ?', [child.id]);
		await expect(HeadlessRevisionHistory.listRevisions({ notebook_ids: [child.id] })).rejects.toMatchObject({ code: 'notebook_unavailable' });
		expect((await HeadlessRevisionHistory.listRevisions({ notebook_ids: [destination.id] })).items.map(item => item.revision_id)).toEqual([movedRevision.id]);
	});

	it('retains deleted history, masks unavailable current metadata and follows conditional revision lock visibility', async () => {
		const scopedFolder = await Folder.save({ title: 'Synthetic scope' });
		const notes = [];
		for (const title of ['Deleted', 'Encrypted', 'Locked', 'Missing']) {
			const note = await Note.save({ title, parent_id: scopedFolder.id });
			await Note.revisionService().createNoteRevision_(note, null, true);
			notes.push(note);
		}
		await Note.db().exec('UPDATE notes SET deleted_time = 1 WHERE id = ?', [notes[0].id]);
		await Note.db().exec('UPDATE notes SET encryption_applied = 1 WHERE id = ?', [notes[1].id]);
		await Note.db().exec('UPDATE notes SET is_locked = 1 WHERE id = ?', [notes[2].id]);
		await Note.db().exec('DELETE FROM notes WHERE id = ?', [notes[3].id]);
		const rows = await HeadlessRevisionHistory.listRevisions({});
		expect(rows.items).toHaveLength(4);
		for (const row of rows.items) expect(row).toMatchObject({ current_title: null, current_notebook_id: null });
		expect((await HeadlessRevisionHistory.listRevisions({ notebook_ids: [scopedFolder.id] })).items).toEqual([]);
		expect((await HeadlessRevisionHistory.listRevisions({ note_ids: [notes[3].id] })).items).toHaveLength(1);
		await Revision.db().exec('UPDATE revisions SET is_locked = 1 WHERE item_id = ?', [notes[3].id]);
		const originalFlag = Setting.value('featureFlag.noteLock');
		try {
			Setting.setValue('featureFlag.noteLock', true);
			expect((await HeadlessRevisionHistory.listRevisions({})).items).toHaveLength(3);
			Setting.setValue('featureFlag.noteLock', false);
			expect((await HeadlessRevisionHistory.listRevisions({})).items).toHaveLength(4);
		} finally {
			Setting.setValue('featureFlag.noteLock', originalFlag);
		}
	});

	it('lists, reconstructs, and compares arbitrary snapshots and the current note', async () => {
		const first = await Note.save({
			title: 'Before',
			body: 'Line one\nLine two',
			is_todo: 1,
			todo_completed: 0,
			user_data: '{"private":"not tracked"}',
		});
		const firstRevision = await Note.revisionService().createNoteRevision_(first, null, true);

		const second = await Note.save({
			id: first.id,
			title: 'Middle',
			body: 'Line one\nInserted line\nLine two',
			todo_completed: 1,
		});
		const secondRevision = await Note.revisionService().createNoteRevision_(second, null, true);

		const third = await Note.save({
			id: first.id,
			title: 'Later',
			body: 'Line one\nInserted line\nLine two\nLast line',
			todo_completed: 1,
		});
		const thirdRevision = await Note.revisionService().createNoteRevision_(third, null, true);

		const latestPage = await HeadlessRevisionHistory.listNoteRevisions({ note_id: first.id, limit: 2 });
		expect(latestPage.items.map(item => item.revision_id)).toEqual([thirdRevision.id, secondRevision.id]);
		expect(latestPage.items[0].captured_time).toBe(thirdRevision.item_updated_time);
		expect(latestPage.items[0].parent_revision_id).toBe(secondRevision.id);
		expect(latestPage.hasMore).toBe(true);

		const olderPage = await HeadlessRevisionHistory.listNoteRevisions({ note_id: first.id, page: 2, limit: 2 });
		expect(olderPage.items.map(item => item.revision_id)).toEqual([firstRevision.id]);
		expect(olderPage.hasMore).toBe(false);

		const historical = await HeadlessRevisionHistory.readNoteRevision({ note_id: first.id, revision_id: firstRevision.id });
		expect(historical).toMatchObject({
			note_id: first.id,
			revision_id: firstRevision.id,
			captured_time: firstRevision.item_updated_time,
			title: 'Before',
			body: 'Line one\nLine two',
			metadata: { todo_completed: 0 },
		});
		expect(historical.metadata).not.toHaveProperty('user_data');

		const arbitraryCompare = await HeadlessRevisionHistory.compareNoteRevisions({
			note_id: first.id,
			from_revision_id: firstRevision.id,
			to_revision_id: thirdRevision.id,
		});
		expect(arbitraryCompare.to_current).toBe(false);
		expect(arbitraryCompare.from_body_total_line_count).toBe(2);
		expect(arbitraryCompare.to_body_total_line_count).toBe(4);
		expect(arbitraryCompare.title_diff).toContain('-Before');
		expect(arbitraryCompare.title_diff).toContain('+Later');
		expect(arbitraryCompare.body_diff).toContain('+Inserted line');
		expect(arbitraryCompare.body_diff).toContain('+Last line');
		expect(arbitraryCompare.metadata_changes).toContainEqual({
			field: 'todo_completed',
			from: { present: true, value: 0 },
			to: { present: true, value: 1 },
		});

		await Note.save({
			id: first.id,
			title: 'Current',
			body: 'Line one\nInserted line\nCurrent line',
		});
		const currentCompare = await HeadlessRevisionHistory.compareNoteRevisions({
			note_id: first.id,
			from_revision_id: firstRevision.id,
		});
		expect(currentCompare.to_current).toBe(true);
		expect(currentCompare.to_body_total_line_count).toBe(3);
		expect(currentCompare.to_revision_id).not.toBe(thirdRevision.id);
		expect(await Revision.load(currentCompare.to_revision_id)).toBeTruthy();
		expect(currentCompare.title_diff).toContain('+Current');
		expect(currentCompare.body_diff).toContain('+Current line');

		const missingNote = jest.spyOn(Note, 'load').mockResolvedValue(null);
		try {
			await expect(HeadlessRevisionHistory.readNoteRevision({ note_id: first.id, revision_id: secondRevision.id }))
				.resolves.toMatchObject({ title: 'Middle' });
			expect(missingNote).not.toHaveBeenCalled();
		} finally {
			missingNote.mockRestore();
		}
	});

	it('counts logical lines in complete reconstructed bodies across newline styles', async () => {
		const mixed = await Note.save({ title: 'Mixed endings', body: 'one\r\ntwo\nthree\rfour\r\n' });
		const mixedRevision = await Note.revisionService().createNoteRevision_(mixed, null, true);

		const empty = await Note.save({ id: mixed.id, body: '' });
		const emptyRevision = await Note.revisionService().createNoteRevision_(empty, null, true);
		const mixedToEmpty = await HeadlessRevisionHistory.compareNoteRevisions({
			note_id: mixed.id,
			from_revision_id: mixedRevision.id,
			to_revision_id: emptyRevision.id,
		});
		expect(mixedToEmpty.from_body_total_line_count).toBe(5);
		expect(mixedToEmpty.to_body_total_line_count).toBe(1);

		const trailingBreak = await Note.save({ id: mixed.id, body: 'last line\n' });
		const trailingBreakRevision = await Note.revisionService().createNoteRevision_(trailingBreak, null, true);
		const emptyToTrailingBreak = await HeadlessRevisionHistory.compareNoteRevisions({
			note_id: mixed.id,
			from_revision_id: emptyRevision.id,
			to_revision_id: trailingBreakRevision.id,
		});
		expect(emptyToTrailingBreak.from_body_total_line_count).toBe(1);
		expect(emptyToTrailingBreak.to_body_total_line_count).toBe(2);
	});

	it('rejects reconstruction when an ancestor is missing', async () => {
		const first = await Note.save({ title: 'Original', body: 'Original body' });
		await Note.revisionService().createNoteRevision_(first, null, true);

		const second = await Note.save({ id: first.id, title: 'Updated', body: 'Updated body' });
		const secondRevision = await Note.revisionService().createNoteRevision_(second, null, true);
		await Revision.save({ ...secondRevision, parent_id: '00000000000000000000000000000000' });

		await expect(HeadlessRevisionHistory.readNoteRevision({ note_id: first.id, revision_id: secondRevision.id }))
			.rejects.toMatchObject({ code: 'revision_history_broken' });
	});
});
