import HeadlessSearchService, { ListScopedNoteBodiesRequest } from './HeadlessSearchService';
import { NoteEntity } from './database/types';
import { db, setupDatabaseAndSynchronizer, switchClient } from '../testing/test-utils';
import Note from '../models/Note';
import Setting from '../models/Setting';
import SearchEngine, { ProcessResultsRow, SearchType } from './search/SearchEngine';
import SearchEngineUtils from './search/SearchEngineUtils';

/** Produce stable fixture IDs whose lexical ordering matches their numeric suffix. */
const noteId = (value: number): string => value.toString(16).padStart(32, '0');
/** Save a readable note while allowing individual eligibility and content variations. */
const saveNote = async (id: string, values: Partial<NoteEntity> = {}): Promise<NoteEntity> => Note.save({
	id,
	parent_id: '',
	title: 'alpha',
	body: `Saved body ${id}`,
	encryption_applied: 0,
	deleted_time: 0,
	is_locked: 0,
	is_conflict: 0,
	...values,
}, { isNew: true });
/** Public fields requested by the existing REST search adapter. */
const fields = ['id', 'parent_id', 'title', 'body', 'created_time', 'updated_time', 'is_todo', 'todo_due', 'todo_completed', 'source', 'source_application', 'source_url', 'markup_language', 'encryption_applied', 'deleted_time', 'is_locked'];
/** Strip the native model's extra type marker as the REST collection response does. */
const publicNote = (note: NoteEntity): NoteEntity => Object.fromEntries(fields.map(field => [field, note[field as keyof NoteEntity]]));

describe('services/HeadlessSearchService', () => {
	/** Real native search engine attached to the test SQLite database. */
	let engine: SearchEngine;
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		engine = new SearchEngine();
		engine.setDb(db());
		jest.spyOn(SearchEngine, 'instance').mockReturnValue(engine);
	});
	afterEach(() => jest.restoreAllMocks());

	it('matches native ranked pages, public fields, wildcard, Basic and non-Latin queries', async () => {
		await saveNote(noteId(1), { title: 'alphabet', body: 'alpha alpha 东京' });
		await saveNote(noteId(2), { title: 'alpha', body: 'alpha 东京' });
		await saveNote(noteId(3), { title: 'alpha todo', is_todo: 1, todo_completed: 123 });
		await saveNote(noteId(4), { title: 'unrelated', body: 'Different saved text' });
		await engine.syncTables();
		Setting.setValue('showCompletedTodos', false);

		for (const query of ['alph', '/alpha', '东京', 'iscompleted:1']) {
			const expected = (await SearchEngineUtils.notesForQuery(query, false, { fields: fields.slice(), appendWildCards: true }, engine)).notes;
			const search = jest.spyOn(engine, 'search');
			for (let page = 1; page <= Math.ceil(expected.length / 2) + 1; page++) {
				search.mockClear();
				const result = await HeadlessSearchService.searchNotes({ query, page, limit: 2 });
				expect(search).toHaveBeenCalledTimes(1);
				expect(result).toEqual({
					items: expected.slice((page - 1) * 2, page * 2).map(publicNote),
					total: expected.length,
					hasMore: expected.length > page * 2,
				});
			}
			search.mockRestore();
		}
	});

	it('preserves first-hit deduplication, live preview rules and eligibility after page selection', async () => {
		const notes = [noteId(1), noteId(2), noteId(3), noteId(4), noteId(5)];
		await saveNote(notes[0], { is_locked: 1 });
		await saveNote(notes[1]);
		await saveNote(notes[2], { encryption_applied: 1 });
		await saveNote(notes[3], { is_conflict: 1 });
		await saveNote(notes[4], { deleted_time: 1 });
		const rankedIds = [notes[0], noteId(99), notes[1], notes[0], notes[2], notes[3], notes[4]];
		const search = jest.spyOn(engine, 'search').mockResolvedValue(rankedIds.map(id => ({ id } as ProcessResultsRow)));
		const previews = jest.spyOn(Note, 'previews');

		const first = await HeadlessSearchService.searchNotes({ query: 'alpha', limit: 1 });
		expect(first).toEqual({ items: [], total: 1, hasMore: true });
		expect(search).toHaveBeenCalledWith('alpha', { searchType: SearchType.Auto, appendWildCards: true });
		expect(search).toHaveBeenCalledTimes(1);
		const bodyReads = previews.mock.calls.filter(([, options]) => Array.isArray(options.fields) && options.fields.includes('body'));
		expect(bodyReads).toHaveLength(0);

		const second = await HeadlessSearchService.searchNotes({ query: 'alpha', page: 2, limit: 1 });
		expect(second.items.map(note => note.id)).toEqual([notes[1]]);
		expect(second.items[0].body).toBe(`Saved body ${notes[1]}`);
		expect(second.items[0]).not.toHaveProperty('type_');
		expect(second.total).toBe(1);
		expect(second.hasMore).toBe(true);
		expect(await HeadlessSearchService.searchNotes({ query: 'alpha', page: 3, limit: 1 })).toEqual({ items: [], total: 1, hasMore: false });
	});

	it('bounds metadata reads and hydrates bodies only for the requested ranked page', async () => {
		const ids = Array.from({ length: 305 }, (_, index) => noteId(index + 1));
		for (const id of ids) await saveNote(id);
		jest.spyOn(engine, 'search').mockResolvedValue(ids.map(id => ({ id } as ProcessResultsRow)));
		const previews = jest.spyOn(Note, 'previews');

		const result = await HeadlessSearchService.searchNotes({ query: 'alpha', page: 2, limit: 2 });
		expect(result.items.map(note => note.id)).toEqual(ids.slice(2, 4));
		expect(result.total).toBe(305);
		expect(previews.mock.calls).toHaveLength(3);
		expect(previews.mock.calls.slice(0, 2).every(([, options]) => !options.fields.includes('body'))).toBe(true);
		expect(previews.mock.calls[2][1].fields).toContain('body');
		const hydratedNotes: NoteEntity[] = await previews.mock.results[2].value;
		expect(hydratedNotes.map(note => note.id).sort()).toEqual(ids.slice(2, 4));
	});

	it('pages the exact notebook/note union in ID order and excludes conflicts and unreadable rows', async () => {
		const notebook = noteId(100);
		const otherNotebook = noteId(101);
		await saveNote(noteId(1), { parent_id: notebook });
		await saveNote(noteId(2), { parent_id: otherNotebook });
		await saveNote(noteId(3), { parent_id: notebook });
		await saveNote(noteId(4), { parent_id: notebook, is_conflict: 1 });
		await saveNote(noteId(5), { parent_id: notebook, encryption_applied: 1 });
		await saveNote(noteId(6), { parent_id: notebook, deleted_time: 1 });
		await saveNote(noteId(7), { parent_id: notebook, is_locked: 1 });
		await saveNote(noteId(8), { parent_id: otherNotebook });
		const request = { notebook_ids: [notebook], note_ids: [noteId(2), noteId(1)], limit: 2 };

		const first = await HeadlessSearchService.listScopedNoteBodies(request);
		expect(first.items.map(note => note.id)).toEqual([noteId(1), noteId(2)]);
		expect(first.items[0].body).toBe(`Saved body ${noteId(1)}`);
		expect(first.items[0]).not.toHaveProperty('type_');
		expect(first.hasMore).toBe(true);
		expect(first.next_cursor).toBe(noteId(2));
		const last = await HeadlessSearchService.listScopedNoteBodies({ ...request, after_id: first.next_cursor });
		expect(last.items.map(note => note.id)).toEqual([noteId(3)]);
		expect(last.hasMore).toBe(false);
		expect(last.next_cursor).toBeNull();
		expect(await HeadlessSearchService.listScopedNoteBodies({ notebook_ids: [], note_ids: [] })).toEqual({ items: [], hasMore: false, next_cursor: null });
	});

	it('rejects malformed action inputs before running native queries', async () => {
		for (const input of [{ query: '' }, { query: 'alpha', page: 0 }, { query: 'alpha', limit: 101 }, { query: 'alpha', extra: true }]) {
			await expect(HeadlessSearchService.searchNotes(input as never)).rejects.toMatchObject({ code: 'invalid_headless_query_input' });
		}
		const scopedInputs: ListScopedNoteBodiesRequest[] = [{ notebook_ids: ['bad'], note_ids: [] }, { notebook_ids: [], note_ids: [], after_id: 'bad' }, { notebook_ids: [], note_ids: [], limit: 0 }];
		for (const input of scopedInputs) {
			await expect(HeadlessSearchService.listScopedNoteBodies(input)).rejects.toMatchObject({ code: 'invalid_headless_query_input' });
		}
	});
});
