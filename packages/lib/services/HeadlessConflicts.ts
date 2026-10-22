import JoplinError from '../JoplinError';
import Note from '../models/Note';
import type { NoteEntity } from './database/types';

/** Pagination options for listing active, readable native conflict copies. */
export interface ListConflictsRequest {
	/** One-based page number; defaults to 1. */
	page?: number;
	/** Number of conflicts to return; defaults to 20. */
	limit?: number;
}

/** Stable metadata for one active, readable conflict copy. */
export interface ConflictListItem {
	/** Stable native conflict note ID. */
	id: string;
	/** Conflict copy title. */
	title: string;
	/** ID of the original note, or an empty string when it is unlinked. */
	conflict_original_id: string;
	/** Native creation time in milliseconds. */
	created_time: number;
	/** Native update time in milliseconds. */
	updated_time: number;
}

/** One page of active, readable conflict copies, newest first. */
export interface ListConflictsResult {
	/** Conflict copies on this page. */
	items: ConflictListItem[];
	/** Whether another readable conflict exists after this page. */
	hasMore: boolean;
}

/** Identifies one native conflict copy to inspect with its original note. */
export interface ReadConflictRequest {
	/** Stable Joplin note ID of a note marked as a conflict copy. */
	id: string;
}

/** Explicitly allowlisted native note fields returned for a readable side. */
export interface NoteSnapshot {
	/** Stable native note ID. */
	id: string;
	/** Native parent notebook ID. */
	parent_id: string;
	/** Note title. */
	title: string;
	/** Note body in its native markup format. */
	body: string;
	/** Native creation time in milliseconds. */
	created_time: number;
	/** Native update time in milliseconds. */
	updated_time: number;
	/** Native numeric to-do flag. */
	is_todo: number;
	/** Native numeric to-do completion time. */
	todo_completed: number;
	/** Native numeric markup language identifier. */
	markup_language: number;
	/** Native numeric conflict flag. */
	is_conflict: number;
	/** ID of the source note, or an empty string when unlinked. */
	conflict_original_id: string;
}

/** One conflict or original side and its explicit native availability state. */
export interface ConflictSide {
	/** Native note ID, or null when no original was linked. */
	id: string|null;
	/** Whether the side can be read, or why it cannot be read. */
	status: 'available'|'missing'|'trashed'|'encrypted'|'locked'|'unlinked';
	/** Allowlisted native note fields, included only when status is available. */
	note?: NoteSnapshot;
}

/** The conflict copy and its original note, each with an explicit availability state. */
export interface ReadConflictResult {
	/** The requested conflict copy. */
	conflict: ConflictSide;
	/** Its linked original note, or an unlinked marker. */
	original: ConflictSide;
}

/** Default to the first page when no page is requested. */
const defaultPage = 1;
/** Match the headless sidecar's documented default page size. */
const defaultLimit = 20;

/** Raise the stable error used for malformed conflict requests. */
const invalidRequest = (message: string): never => {
	throw new JoplinError(message, 'invalid_conflict_input');
};

/** Raise the stable error used for missing notes and non-conflict note IDs. */
const notFound = (): never => {
	throw new JoplinError('The requested conflict was not found.', 'conflict_not_found');
};

/** Validate a stable lowercase 32-character Joplin ID. */
const validateId = (value: unknown, name = 'conflict ID'): void => {
	if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) invalidRequest(`A valid ${name} is required.`);
};

/** Reject non-object requests and unsupported input fields. */
const validateRequest = (value: unknown, allowedFields: string[]): void => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRequest('A conflict request is required.');
	if (Object.keys(value).some(key => !allowedFields.includes(key))) invalidRequest('The conflict request contains an unsupported property.');
};

/** Select only fields needed for availability and the public note snapshot. */
const sideFields = [
	'id',
	'parent_id',
	'title',
	'body',
	'created_time',
	'updated_time',
	'is_todo',
	'todo_completed',
	'markup_language',
	'is_conflict',
	'conflict_original_id',
	'deleted_time',
	'encryption_applied',
	'is_locked',
];

/** Build the fixed public snapshot without exposing other native note fields. */
const noteSnapshot = (note: NoteEntity): NoteSnapshot => ({
	id: note.id!,
	parent_id: note.parent_id!,
	title: note.title!,
	body: note.body!,
	created_time: note.created_time!,
	updated_time: note.updated_time!,
	is_todo: note.is_todo!,
	todo_completed: note.todo_completed!,
	markup_language: note.markup_language!,
	is_conflict: note.is_conflict!,
	conflict_original_id: note.conflict_original_id!,
});

/** Load one native note and omit its contents whenever it is unavailable. */
const loadSide = async (id: string): Promise<{ row: NoteEntity|null; side: ConflictSide }> => {
	const note = await Note.load(id, { fields: sideFields });
	if (!note) return { row: null, side: { id, status: 'missing' } };
	if (note.deleted_time > 0) return { row: note, side: { id, status: 'trashed' } };
	if (note.encryption_applied !== 0) return { row: note, side: { id, status: 'encrypted' } };
	if (note.is_locked) return { row: note, side: { id, status: 'locked' } };
	return { row: note, side: { id, status: 'available', note: noteSnapshot(note) } };
};

/** Read-only native queries for headless conflict inspection actions. */
export default class HeadlessConflicts {
	/** Lists active, readable conflicts in update order without counting a second query. */
	public static async listConflicts(request: ListConflictsRequest): Promise<ListConflictsResult> {
		validateRequest(request, ['page', 'limit']);

		const page = request.page ?? defaultPage;
		const limit = request.limit ?? defaultLimit;
		if (!Number.isSafeInteger(page) || page < 1) invalidRequest('page must be a positive integer.');
		if (!Number.isSafeInteger(limit) || limit < 1) invalidRequest('limit must be a positive integer.');
		const offset = (page - 1) * limit;
		if (!Number.isSafeInteger(offset)) invalidRequest('The requested page is too large.');
		const fetchLimit = limit + 1;
		if (!Number.isSafeInteger(fetchLimit) || !Number.isSafeInteger(offset + fetchLimit)) invalidRequest('The requested page is too large.');

		const rows = await Note.modelSelectAll<NoteEntity>(`
			SELECT id, title, conflict_original_id, created_time, updated_time
			FROM notes
			WHERE is_conflict = 1 AND deleted_time = 0 AND encryption_applied = 0 AND is_locked = 0
			ORDER BY updated_time DESC, id ASC
			LIMIT ? OFFSET ?`, [fetchLimit, offset]);

		return {
			items: rows.slice(0, limit).map(note => ({
				id: note.id!,
				title: note.title!,
				conflict_original_id: note.conflict_original_id!,
				created_time: note.created_time!,
				updated_time: note.updated_time!,
			})),
			hasMore: rows.length > limit,
		};
	}

	/** Reads a marked conflict and its linked original without creating revision history. */
	public static async readConflict(request: ReadConflictRequest): Promise<ReadConflictResult> {
		validateRequest(request, ['id']);
		validateId(request.id, 'conflict ID');

		const conflict = await loadSide(request.id);
		if (!conflict.row || conflict.row.is_conflict !== 1) notFound();

		const originalId = conflict.row.conflict_original_id;
		const original = typeof originalId === 'string' && originalId.length > 0
			? (await loadSide(originalId)).side
			: { id: null, status: 'unlinked' as const };

		return { conflict: conflict.side, original };
	}
}
