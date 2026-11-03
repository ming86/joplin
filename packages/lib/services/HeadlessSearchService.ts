import Logger from '@joplin/utils/Logger';
import JoplinError from '../JoplinError';
import Note from '../models/Note';
import type { NoteEntity } from './database/types';
import SearchEngine, { SearchType } from './search/SearchEngine';
import { reportHeadlessPerformance } from './HeadlessPerformance';

/** Public note fields shared by the private search and grep body-page actions. */
const publicNoteFields = ['id', 'parent_id', 'title', 'body', 'created_time', 'updated_time', 'is_todo', 'todo_due', 'todo_completed', 'source', 'source_application', 'source_url', 'markup_language', 'encryption_applied', 'deleted_time', 'is_locked'];
/** Read only eligibility metadata while resolving the native engine's ranked IDs. */
const metadataFields = ['id', 'encryption_applied', 'deleted_time', 'is_locked'];
/** Bound live metadata reads without changing the engine's complete ranking. */
const metadataBatchSize = 300;
/** Match the Data API's default page size. */
const defaultLimit = 100;
/** Emit counts and elapsed times without including queries or saved content. */
const logger = Logger.create('HeadlessSearchService');

/** Native keyword search with the same query syntax and pagination as the REST search route. */
export interface SearchNotesRequest {
	/** Native search expression; a leading slash selects Basic search. */
	query: string;
	/** One-based page number; defaults to 1. */
	page?: number;
	/** Number of live ranked notes per page, before readable-note filtering. */
	limit?: number;
}

/** A ranked page and exact readable total from one native search execution. */
export interface SearchNotesResult {
	/** Readable notes on the requested native page, with public fields and bodies. */
	items: NoteEntity[];
	/** Number of readable live notes across all ranked results. */
	total: number;
	/** Whether another live ranked page exists, before readable-note filtering. */
	hasMore: boolean;
}

/** Exact current notebook/note union for a bounded grep candidate body page. */
export interface ListScopedNoteBodiesRequest {
	/** Resolved notebook IDs; descendant expansion belongs to the caller. */
	notebook_ids: string[];
	/** Explicit note IDs included alongside current notebook members. */
	note_ids: string[];
	/** Last returned note ID; omitted for the first page. */
	after_id?: string;
	/** Maximum candidate notes per page; defaults to 100. */
	limit?: number;
}

/** One current body page, without revision capture or a whole-scope snapshot guarantee. */
export interface ListScopedNoteBodiesResult {
	/** Readable, non-conflict notes ordered by ascending native ID. */
	items: NoteEntity[];
	/** Whether another candidate exists after the returned page. */
	hasMore: boolean;
	/** Last returned ID when another page exists, otherwise null. */
	next_cursor: string | null;
}

/** Reject malformed values at the private action boundary with a stable public code. */
function invalidRequest(message: string): never {
	throw new JoplinError(message, 'invalid_headless_query_input');
}

/** Validate the fixed request envelope before examining its typed properties. */
function validateEnvelope(value: unknown, fields: string[]): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRequest('A query request object is required.');
	if (Object.keys(value).some(key => !fields.includes(key))) invalidRequest('Unsupported query request property.');
}

/** Validate the bounded note-count limit used by both private query actions. */
function validateLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidRequest('limit must be an integer between 1 and 100.');
}

/** Apply the sidecar's readable-note rule after native live-note selection. */
function isReadable(note: NoteEntity): boolean {
	return note.encryption_applied === 0 && !note.deleted_time && !note.is_locked;
}

/** Drop model bookkeeping and private fields from the native action response. */
function publicNote(note: NoteEntity): NoteEntity {
	return Object.fromEntries(publicNoteFields.filter(field => Object.prototype.hasOwnProperty.call(note, field)).map(field => [field, note[field as keyof NoteEntity]]));
}

/** Load live note previews in bounded ID chunks, preserving native deleted/conflict rules. */
async function loadPreviews(ids: string[], fields: string[]): Promise<NoteEntity[]> {
	const notes: NoteEntity[] = [];
	for (let offset = 0; offset < ids.length; offset += metadataBatchSize) {
		const batch = ids.slice(offset, offset + metadataBatchSize);
		notes.push(...await Note.previews(null, {
			order: [],
			fields: fields.slice(),
			conditions: [`id IN (${Note.escapeIdsForSql(batch)})`],
		}));
	}
	return notes;
}

/** Focused native read primitives for the account-bound service's search and grep adapters. */
export default class HeadlessSearchService {
	/**
	 * Execute the native engine once, resolve live metadata, and hydrate only the requested page.
	 * Keep native page membership before readable filtering, matching the existing REST adapter.
	 */
	public static async searchNotes(request: SearchNotesRequest): Promise<SearchNotesResult> {
		validateEnvelope(request, ['query', 'page', 'limit']);
		if (typeof request.query !== 'string' || !request.query.trim()) invalidRequest('A nonempty native search query is required.');
		const page = request.page ?? 1;
		const limit = request.limit ?? defaultLimit;
		validateLimit(limit);
		const offset = (page - 1) * limit;
		if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset + limit)) invalidRequest('The requested search page is invalid.');

		// Match SearchEngineUtils.notesForQuery(query, false, { appendWildCards: true }).
		// The engine owns ranking, OCR-associated hits, Basic/non-Latin modes, and semantic integration.
		const searchStarted = Date.now();
		const results = await SearchEngine.instance().search(request.query, {
			searchType: request.query[0] === '/' ? SearchType.Basic : SearchType.Auto,
			appendWildCards: true,
		});
		reportHeadlessPerformance(logger, { stage: 'nativeSearch', elapsedMs: Date.now() - searchStarted, resultCount: results.length });

		// Native previews collapse duplicate hits, and notesForQuery orders each note at its first hit.
		const rankedIds = [...new Set(results.map(result => result.id))];
		const metadataStarted = Date.now();
		const metadata = new Map((await loadPreviews(rankedIds, metadataFields)).map(note => [note.id, note]));
		const liveIds = rankedIds.filter(id => metadata.has(id));
		const total = liveIds.reduce((count, id) => count + (isReadable(metadata.get(id)) ? 1 : 0), 0);
		reportHeadlessPerformance(logger, { stage: 'searchMetadata', elapsedMs: Date.now() - metadataStarted, liveCount: liveIds.length, readableCount: total });

		const hydrationStarted = Date.now();
		const pageIds = liveIds.slice(offset, offset + limit);
		const readablePageIds = pageIds.filter(id => isReadable(metadata.get(id)));
		const pageNotes = new Map((await loadPreviews(readablePageIds, publicNoteFields)).map(note => [note.id, note]));
		const items = readablePageIds.map(id => pageNotes.get(id)).filter(note => note && isReadable(note)).map(publicNote);
		reportHeadlessPerformance(logger, { stage: 'searchPageHydration', elapsedMs: Date.now() - hydrationStarted, pageCount: pageIds.length, returnedCount: items.length });
		return { items, total, hasMore: liveIds.length > offset + limit };
	}

	/** Read an exact resolved notebook/explicit-note union in ascending ID order without revision work. */
	public static async listScopedNoteBodies(request: ListScopedNoteBodiesRequest): Promise<ListScopedNoteBodiesResult> {
		validateEnvelope(request, ['notebook_ids', 'note_ids', 'after_id', 'limit']);
		for (const field of ['notebook_ids', 'note_ids'] as const) {
			if (!Array.isArray(request[field]) || request[field].some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) invalidRequest(`${field} must contain valid native IDs.`);
		}
		if (request.after_id !== undefined && (typeof request.after_id !== 'string' || !/^[a-f0-9]{32}$/.test(request.after_id))) invalidRequest('after_id must be a valid native note ID.');
		const limit = request.limit ?? defaultLimit;
		validateLimit(limit);

		const scope: string[] = [];
		if (request.notebook_ids.length) scope.push(`parent_id IN (${Note.escapeIdsForSql(request.notebook_ids)})`);
		if (request.note_ids.length) scope.push(`id IN (${Note.escapeIdsForSql(request.note_ids)})`);
		if (!scope.length) return { items: [], hasMore: false, next_cursor: null };

		const started = Date.now();
		const candidates = await Note.modelSelectAll<NoteEntity>(`
			SELECT ${Note.previewFieldsSql(publicNoteFields)} FROM notes
			WHERE id > ? AND (${scope.join(' OR ')})
				AND encryption_applied = 0 AND deleted_time = 0 AND is_locked = 0 AND is_conflict = 0
			ORDER BY id ASC LIMIT ?`, [request.after_id ?? '', limit + 1]);
		const items = candidates.slice(0, limit).map(publicNote);
		const hasMore = candidates.length > limit;
		reportHeadlessPerformance(logger, { stage: 'scopedBodyRead', elapsedMs: Date.now() - started, returnedCount: items.length, hasMore });
		return { items, hasMore, next_cursor: hasMore ? items[items.length - 1].id : null };
	}
}
