import BaseModel from '../BaseModel';
import Folder from '../models/Folder';
import ItemChange from '../models/ItemChange';
import Note from '../models/Note';
import Revision from '../models/Revision';
import Setting from '../models/Setting';
import { db, revisionService, setupDatabaseAndSynchronizer, switchClient } from '../testing/test-utils';
import { readNote, updateNote } from './HeadlessNoteService';

describe('services/HeadlessNoteService', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		Setting.setValue('revisionService.intervalBetweenRevisions', 0);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('captures an old current snapshot at capture time with unchanged note timestamps, even when collection is disabled', async () => {
		const oldTime = Date.now() - 365 * 24 * 60 * 60 * 1000;
		const note = await Note.save({ title: 'Old note', body: '<p>Unchanged HTML</p>', markup_language: 2, updated_time: oldTime, user_updated_time: oldTime }, { autoTimestamp: false });
		Setting.setValue('revisionService.enabled', false);
		const before = await Note.load(note.id);
		const observedAt = Date.now();
		const read = await readNote(note.id);
		const captured = await Revision.load(read.revision_id);
		expect(captured.item_updated_time).toBeGreaterThanOrEqual(observedAt);
		expect(await Note.load(note.id)).toEqual(before);
		expect(Setting.value('revisionService.enabled')).toBe(false);
		expect(await Revision.mergeDiffsStrict(captured)).toMatchObject({ title: 'Old note', body: '<p>Unchanged HTML</p>', metadata: { markup_language: 2 } });
		expect((await readNote(note.id)).revision_id).toBe(read.revision_id);
		await revisionService().deleteOldRevisions(90 * 24 * 60 * 60 * 1000);
		expect(await Revision.load(read.revision_id)).not.toBeNull();
	});

	it('captures both sides of edits, preserves existing history, and avoids collector duplicates', async () => {
		const note = await Note.save({ title: 'Before', body: 'one' });
		const initial = await readNote(note.id);
		const edited = await updateNote({ id: note.id, base_revision_id: initial.revision_id, changes: { title: 'After', append: '\ntwo' } });
		expect(edited).toMatchObject({ title: 'After', body: 'one\ntwo', previous_revision_id: initial.revision_id, changed: true });
		expect(edited.revision_id).not.toBe(initial.revision_id);
		let revisions = await Revision.allByType(BaseModel.TYPE_NOTE, note.id);
		expect(revisions).toHaveLength(2);
		expect(revisions[1].parent_id).toBe(initial.revision_id);
		expect(revisions[1].item_updated_time).toBeGreaterThan(revisions[0].item_updated_time);
		expect(await Revision.mergeDiffsStrict(revisions[0])).toMatchObject({ title: 'Before', body: 'one' });
		expect(await Revision.mergeDiffsStrict(revisions[1])).toMatchObject({ title: 'After', body: 'one\ntwo' });
		Setting.setValue('revisionService.oldNoteInterval', 0);
		await revisionService().collectRevisions();
		revisions = await Revision.allByType(BaseModel.TYPE_NOTE, note.id);
		expect(revisions).toHaveLength(2);
		expect((await readNote(note.id)).revision_id).toBe(edited.revision_id);
	});

	it('applies source-ordered body hunks with metadata in one native history edit', async () => {
		const note = await Note.save({
			title: 'Context patch',
			body: 'Prelude\n## Travel\nWe arrive Monday.\n## Budget\nTotal: 100\nFooter',
			source_url: 'https://before.example',
		});
		const initial = await readNote(note.id);
		const edited = await updateNote({
			id: note.id,
			base_revision_id: initial.revision_id,
			changes: {
				body_patch: '@@\n ## Travel\n-We arrive Monday.\n+We arrive Tuesday.\n@@\n ## Budget\n-Total: 100\n+Total: 120\n',
				source_url: 'https://after.example',
			},
		});

		expect(edited).toMatchObject({
			body: 'Prelude\n## Travel\nWe arrive Tuesday.\n## Budget\nTotal: 120\nFooter',
			source_url: 'https://after.example',
			previous_revision_id: initial.revision_id,
			changed: true,
		});
		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, note.id);
		expect(revisions).toHaveLength(2);
		expect(await Revision.mergeDiffsStrict(revisions[0])).toMatchObject({
			body: 'Prelude\n## Travel\nWe arrive Monday.\n## Budget\nTotal: 100\nFooter',
			metadata: { source_url: 'https://before.example' },
		});
		expect(await Revision.mergeDiffsStrict(revisions[1])).toMatchObject({
			body: edited.body,
			metadata: { source_url: 'https://after.example' },
		});
	});

	it('leaves body, metadata, timestamps and history unchanged when a later hunk fails', async () => {
		const note = await Note.save({ title: 'Atomic patch', body: 'one\nmiddle\ntwo', source_url: 'https://before.example' });
		const read = await readNote(note.id);
		const before = await Note.load(note.id);
		const revisionCount = await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id);
		await expect(updateNote({
			id: note.id,
			base_revision_id: read.revision_id,
			changes: {
				body_patch: '@@\n-one\n+ONE\n@@\n-absent\n+replacement\n',
				source_url: 'https://after.example',
			},
		})).rejects.toMatchObject({ code: 'note_patch_not_found' });
		expect(await Note.load(note.id)).toEqual(before);
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(revisionCount);
	});

	it('keeps an identical body patch as a no-op without changing timestamps or history', async () => {
		const note = await Note.save({ title: 'No-op patch', body: 'same\r\nline' });
		const read = await readNote(note.id);
		const before = await Note.load(note.id);
		const result = await updateNote({
			id: note.id,
			base_revision_id: read.revision_id,
			changes: { body_patch: '@@\n-same\n+same\n' },
		});
		expect(result).toMatchObject({ changed: false, revision_id: read.revision_id, previous_revision_id: read.revision_id });
		expect(await Note.load(note.id)).toEqual(before);
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(1);
	});

	it.each([
		['body', { body: 'complete' }],
		['prepend', { prepend: 'prefix' }],
		['append', { append: 'suffix' }],
		['replace_text', { replace_text: { find: 'old', replace: 'new' } }],
	])('rejects a body patch combined with %s before changing the note', async (_mode, bodyChange) => {
		const note = await Note.save({ title: 'Conflicting modes', body: 'old' });
		const read = await readNote(note.id);
		const before = await Note.load(note.id);
		await expect(updateNote({
			id: note.id,
			base_revision_id: read.revision_id,
			changes: { body_patch: '@@\n-old\n+new\n', ...bodyChange },
		})).rejects.toMatchObject({ code: 'note_patch_body_conflict' });
		expect(await Note.load(note.id)).toEqual(before);
	});

	it('rejects a stale or foreign native base without changing notes or retained history', async () => {
		const note = await Note.save({ title: 'First', body: 'First body' });
		const first = await readNote(note.id);
		const second = await updateNote({ id: note.id, base_revision_id: first.revision_id, changes: { body: 'Second body' } });
		const other = await Note.save({ title: 'Other' });
		const otherRead = await readNote(other.id);
		const revisionCount = await Revision.count();
		for (const base of [first.revision_id, otherRead.revision_id]) {
			await expect(updateNote({ id: note.id, base_revision_id: base, changes: { body_patch: '@@\n-First body\n+Overwrite\n' } })).rejects.toMatchObject({ code: 'note_conflict' });
		}
		expect((await Note.load(note.id)).body).toBe('Second body');
		expect(await Revision.count()).toBe(revisionCount);
		expect((await readNote(note.id)).revision_id).toBe(second.revision_id);
	});

	it('allows only one of two same-base concurrent edits', async () => {
		const note = await Note.save({ title: 'Concurrent', body: 'Original' });
		const read = await readNote(note.id);
		const results = await Promise.allSettled([
			updateNote({ id: note.id, base_revision_id: read.revision_id, changes: { body: 'First' } }),
			updateNote({ id: note.id, base_revision_id: read.revision_id, changes: { body: 'Second' } }),
		]);
		expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'note_conflict' } });
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(2);
	});

	it('rejects an earlier native revision after the note returns to its earlier content', async () => {
		const note = await Note.save({ title: 'Reverted', body: 'A' });
		const first = await readNote(note.id);
		const second = await updateNote({ id: note.id, base_revision_id: first.revision_id, changes: { body: 'B' } });
		const third = await updateNote({ id: note.id, base_revision_id: second.revision_id, changes: { body: 'A' } });
		await expect(updateNote({ id: note.id, base_revision_id: first.revision_id, changes: { body: 'Overwrite' } })).rejects.toMatchObject({ code: 'note_conflict' });
		expect((await readNote(note.id)).revision_id).toBe(third.revision_id);
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(3);
	});

	it('rejects an ordinary save that interleaves between the core read and conditional write', async () => {
		const note = await Note.save({ title: 'Concurrent', body: 'Original' });
		const read = await readNote(note.id);
		await ItemChange.waitForAllSaved();
		revisionService().removeChangedSinceCollection(note.id);
		const save = Note.save.bind(Note);
		let intervened = false;
		jest.spyOn(Note, 'save').mockImplementation(async (item, options) => {
			if (options?.expectedItem && !intervened) {
				intervened = true;
				await save({ id: note.id, body: 'External edit' });
			}
			return save(item, options);
		});
		await expect(updateNote({ id: note.id, base_revision_id: read.revision_id, changes: { body_patch: '@@\n-Original\n+MCP edit\n' } })).rejects.toMatchObject({ code: 'note_conflict' });
		expect((await Note.load(note.id)).body).toBe('External edit');
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(1);
		expect(revisionService().changedSinceCollection(note.id)).toBe(true);
	});

	it.each(['delete parent', 'rewrite ancestor', 'insert head'])('rolls back a changed edit when sync revisions %s before commit', async (race) => {
		const note = await Note.save({ title: 'Sync race', body: 'A' });
		const first = await readNote(note.id);
		const current = await updateNote({ id: note.id, base_revision_id: first.revision_id, changes: { body: 'B' } });
		const before = await Note.load(note.id);
		const save = Note.save.bind(Note);
		let intervened = false;
		jest.spyOn(Note, 'save').mockImplementation(async (item, options) => {
			if (options?.expectedItem && !intervened) {
				intervened = true;
				const syncOptions = { trackDeleted: false, changeSource: ItemChange.SOURCE_SYNC, sourceDescription: 'sync: revision race' };
				if (race === 'delete parent') {
					await Revision.delete(current.revision_id, syncOptions);
				} else if (race === 'rewrite ancestor') {
					await Revision.save({ id: first.revision_id, body_diff: Revision.createTextPatch('', 'Rewritten ancestor') }, syncOptions);
				} else {
					const parent = await Revision.load(current.revision_id);
					const draft = revisionService().prepareNoteRevision({ ...before, body: 'Remote history' }, parent, await Revision.mergeDiffsStrict(parent), Date.now() + 1000);
					await Revision.save(draft, syncOptions);
				}
			}
			return save(item, options);
		});
		await expect(updateNote({ id: note.id, base_revision_id: current.revision_id, changes: { body: 'MCP edit' } })).rejects.toMatchObject({ code: 'note_conflict' });
		expect(await Note.load(note.id)).toEqual(before);
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(race === 'delete parent' ? 1 : race === 'insert head' ? 3 : 2);
	});

	it('checks persisted ancestry even when an edit is unchanged', async () => {
		const note = await Note.save({ title: 'Unchanged race', body: 'A' });
		const read = await readNote(note.id);
		const before = await Note.load(note.id);
		const transaction = db().transactionExecBatch.bind(db());
		let intervened = false;
		jest.spyOn(db(), 'transactionExecBatch').mockImplementation(async (queries) => {
			if (!intervened) {
				intervened = true;
				await Revision.delete(read.revision_id, { trackDeleted: false, changeSource: ItemChange.SOURCE_SYNC, sourceDescription: 'sync: deleteLocal' });
			}
			return transaction(queries);
		});
		await expect(updateNote({ id: note.id, base_revision_id: read.revision_id, changes: {} })).rejects.toMatchObject({ code: 'note_conflict' });
		expect(await Note.load(note.id)).toEqual(before);
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(0);
	});

	it('rejects a first read capture if sync inserts history before its transaction', async () => {
		const note = await Note.save({ title: 'First capture race', body: 'A' });
		const before = await Note.load(note.id);
		const transaction = db().transactionExecBatch.bind(db());
		let intervened = false;
		jest.spyOn(db(), 'transactionExecBatch').mockImplementation(async (queries) => {
			if (!intervened) {
				intervened = true;
				const draft = revisionService().prepareNoteRevision(before, null, null, Date.now());
				await Revision.save(draft, { changeSource: ItemChange.SOURCE_SYNC });
			}
			return transaction(queries);
		});
		await expect(readNote(note.id)).rejects.toMatchObject({ code: 'note_conflict' });
		expect(await Note.load(note.id)).toEqual(before);
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(1);
	});

	it('does not capture an unrecorded read against ancestry removed by sync before commit', async () => {
		const note = await Note.save({ title: 'Read race', body: 'A' });
		const read = await readNote(note.id);
		await Note.save({ id: note.id, body: 'B' });
		const transaction = db().transactionExecBatch.bind(db());
		let intervened = false;
		jest.spyOn(db(), 'transactionExecBatch').mockImplementation(async (queries) => {
			if (!intervened) {
				intervened = true;
				await Revision.delete(read.revision_id, { trackDeleted: false, changeSource: ItemChange.SOURCE_SYNC, sourceDescription: 'sync: deleteLocal' });
			}
			return transaction(queries);
		});
		await expect(readNote(note.id)).rejects.toMatchObject({ code: 'note_conflict' });
		expect((await Note.load(note.id)).body).toBe('B');
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(0);
	});

	it('rolls back the note and prepared history when revision persistence fails', async () => {
		const note = await Note.save({ title: 'Before', body: 'Original' });
		const read = await readNote(note.id);
		// A change outside the supported edit fields needs a new before revision as well.
		await Note.save({ id: note.id, author: 'Unrecorded author' });
		await ItemChange.waitForAllSaved();
		revisionService().removeChangedSinceCollection(note.id);
		const before = await Note.load(note.id);
		const originalQuery = Revision.saveQuery.bind(Revision);
		jest.spyOn(Revision, 'saveQuery').mockImplementation((revision, options) => {
			const query = originalQuery(revision, options);
			return { ...query, sql: 'INSERT INTO revision_table_that_does_not_exist (id) VALUES (?)', params: [query.id] };
		});
		await expect(updateNote({ id: note.id, base_revision_id: read.revision_id, changes: { body: 'Changed' } })).rejects.toThrow();
		expect(await Note.load(note.id)).toEqual(before);
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(1);
		expect(revisionService().changedSinceCollection(note.id)).toBe(false);
	});

	it('records an unrecorded before snapshot and retains its metadata through the post revision', async () => {
		const note = await Note.save({ title: 'Before', body: 'Original' });
		const read = await readNote(note.id);
		await Note.save({ id: note.id, author: 'Unrecorded author' });
		const result = await updateNote({ id: note.id, base_revision_id: read.revision_id, changes: { body: 'Changed' } });
		expect(result.previous_revision_id).not.toBe(read.revision_id);
		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, note.id);
		expect(revisions).toHaveLength(3);
		expect(await Revision.mergeDiffsStrict(revisions[1])).toMatchObject({ body: 'Original', metadata: { author: 'Unrecorded author' } });
		expect(await Revision.mergeDiffsStrict(revisions[2])).toMatchObject({ body: 'Changed', metadata: { author: 'Unrecorded author' } });
	});

	it('skips unchanged edits without changing timestamps or duplicating revisions', async () => {
		const note = await Note.save({ title: 'Same', body: 'Same body' });
		const read = await readNote(note.id);
		const before = await Note.load(note.id);
		const result = await updateNote({ id: note.id, base_revision_id: read.revision_id, changes: { title: 'Same', body: 'Same body', todo_completed: false } });
		expect(result).toMatchObject({ changed: false, revision_id: read.revision_id, previous_revision_id: read.revision_id });
		expect(await Note.load(note.id)).toEqual(before);
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(1);
	});

	it('preserves HTML format and checks notebook and to-do metadata in the native base', async () => {
		const folder = await Folder.save({ title: 'Destination' });
		const note = await Note.save({ title: 'HTML', body: '<p>one</p>', markup_language: 2, is_todo: 1 });
		const read = await readNote(note.id);
		const moved = await updateNote({ id: note.id, base_revision_id: read.revision_id, changes: { body: '<p>two</p>', notebook_id: folder.id, todo_completed: true } });
		expect(moved).toMatchObject({ body: '<p>two</p>', markup_language: 2, parent_id: folder.id });
		expect(moved.todo_completed).toBeGreaterThan(0);
		await Note.save({ id: note.id, todo_due: 123 });
		await expect(updateNote({ id: note.id, base_revision_id: moved.revision_id, changes: { title: 'Stale' } })).rejects.toMatchObject({ code: 'note_conflict' });
	});

	it('resets dates on a to-do type change and applies explicit values afterward', async () => {
		const oldCompletion = 9_000_000_000_000;
		const note = await Note.save({ title: 'Type change', is_todo: 1, todo_due: 123, todo_completed: oldCompletion });
		const initial = await readNote(note.id);
		const convertedToNote = await updateNote({ id: note.id, base_revision_id: initial.revision_id, changes: { is_todo: false } });
		expect(convertedToNote).toMatchObject({ is_todo: 0, todo_due: 0, todo_completed: 0 });

		// Dates remain editable on an ordinary note, and repeating its current type preserves them.
		const datedNote = await updateNote({ id: note.id, base_revision_id: convertedToNote.revision_id, changes: { todo_due: 789, todo_completed: true } });
		expect(datedNote).toMatchObject({ is_todo: 0, todo_due: 789 });
		expect(datedNote.todo_completed).toBeGreaterThan(0);
		const sameType = await updateNote({ id: note.id, base_revision_id: datedNote.revision_id, changes: { is_todo: false } });
		expect(sameType).toMatchObject({ changed: false, todo_due: 789, todo_completed: datedNote.todo_completed });

		// A type switch clears a previous completion before an explicit true supplies a fresh one.
		await Note.save({ id: note.id, todo_completed: oldCompletion });
		const beforeTodo = await readNote(note.id);
		const convertedToTodo = await updateNote({
			id: note.id,
			base_revision_id: beforeTodo.revision_id,
			changes: { is_todo: true, todo_due: 1000, todo_completed: true },
		});
		expect(convertedToTodo).toMatchObject({ is_todo: 1, todo_due: 1000 });
		expect(convertedToTodo.todo_completed).toBeGreaterThan(0);
		expect(convertedToTodo.todo_completed).toBeLessThan(oldCompletion);
	});

	it('records due and source URL edits in native history and rejects a stale source URL base', async () => {
		const note = await Note.save({
			title: 'Source metadata',
			is_todo: 1,
			todo_due: 100,
			source: 'clipper',
			source_application: 'web-clipper',
			source_url: 'https://before.example',
		});
		const initial = await readNote(note.id);
		expect(initial).toMatchObject({ source: 'clipper', source_application: 'web-clipper', source_url: 'https://before.example' });
		const edited = await updateNote({
			id: note.id,
			base_revision_id: initial.revision_id,
			changes: { todo_due: -200, source_url: 'https://after.example' },
		});
		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, note.id);
		expect(await Revision.mergeDiffsStrict(revisions[0])).toMatchObject({ metadata: { todo_due: 100, source_url: 'https://before.example' } });
		expect(edited.todo_due).toBe(-200);
		expect(await Revision.mergeDiffsStrict(revisions[1])).toMatchObject({ metadata: { todo_due: -200, source_url: 'https://after.example' } });

		await Note.save({ id: note.id, source_url: 'https://external.example' });
		await expect(updateNote({ id: note.id, base_revision_id: edited.revision_id, changes: { source_url: 'https://overwrite.example' } })).rejects.toMatchObject({ code: 'note_conflict' });
		expect((await Note.load(note.id)).source_url).toBe('https://external.example');
	});

	it('keeps native reconstruction ordered after a captured snapshot and a backdated note save', async () => {
		const note = await Note.save({ title: 'Initial', body: 'A' });
		const first = await readNote(note.id);
		await Note.save({ id: note.id, body: 'B', updated_time: 1, user_updated_time: 1 }, { autoTimestamp: false });
		const second = await readNote(note.id);
		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, note.id);
		expect(revisions).toHaveLength(2);
		expect(revisions[1].id).toBe(second.revision_id);
		expect(revisions[1].parent_id).toBe(first.revision_id);
		expect(revisions[1].item_updated_time).toBeGreaterThan(revisions[0].item_updated_time);
		expect(await Revision.mergeDiffs(revisions[1])).toMatchObject({ body: 'B' });
	});

	it('still preserves a sampled old snapshot when an ordinary edit reverts to earlier recorded content', async () => {
		const now = Date.now();
		const note = await Note.save({ title: 'Native history', body: 'A', updated_time: now - 2000, user_updated_time: now - 2000 }, { autoTimestamp: false });
		await revisionService().createNoteRevision_(await Note.load(note.id));
		Setting.setValue('revisionService.intervalBetweenRevisions', 10_000);
		Setting.setValue('revisionService.oldNoteInterval', 10_000);
		await Note.save({ id: note.id, body: 'B', updated_time: now - 1000, user_updated_time: now - 1000 }, { autoTimestamp: false });
		await revisionService().collectRevisions();
		expect(await Revision.countRevisions(BaseModel.TYPE_NOTE, note.id)).toBe(1);
		await Note.save({ id: note.id, body: 'A' });
		Setting.setValue('revisionService.intervalBetweenRevisions', 0);
		Setting.setValue('revisionService.oldNoteInterval', 0);
		await revisionService().collectRevisions();
		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, note.id);
		expect(revisions).toHaveLength(3);
		expect(await Revision.mergeDiffsStrict(revisions[1])).toMatchObject({ body: 'B' });
		expect(await Revision.mergeDiffsStrict(revisions[2])).toMatchObject({ body: 'A' });
	});

	it('refuses encrypted and incomplete native history instead of returning substitute content', async () => {
		const note = await Note.save({ title: 'History', body: 'A' });
		const read = await readNote(note.id);
		await db().exec('UPDATE revisions SET parent_id = ? WHERE id = ?', ['00000000000000000000000000000000', read.revision_id]);
		await expect(readNote(note.id)).rejects.toMatchObject({ code: 'revision_history_broken' });
		await db().exec('UPDATE revisions SET parent_id = ?, encryption_applied = 1 WHERE id = ?', ['', read.revision_id]);
		await expect(readNote(note.id)).rejects.toMatchObject({ code: 'revision_encrypted' });
	});
});
