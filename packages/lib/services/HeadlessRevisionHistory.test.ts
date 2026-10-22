import Note from '../models/Note';
import Revision from '../models/Revision';
import HeadlessRevisionHistory from './HeadlessRevisionHistory';
import { setupDatabaseAndSynchronizer, switchClient } from '../testing/test-utils';

describe('services/HeadlessRevisionHistory', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
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
