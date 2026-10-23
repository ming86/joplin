import { ModelType } from '../BaseModel';
import JoplinError from '../JoplinError';
import BaseItem from '../models/BaseItem';
import Folder from '../models/Folder';
import Note from '../models/Note';
import restoreItems from './trash/restoreItems';
import type { FolderEntity, NoteEntity } from './database/types';

/** Pagination options for listing native Trash items. */
export interface ListTrashRequest {
	/** One-based page number; defaults to 1. */
	page?: number;
	/** Number of items to return; defaults to 20. */
	limit?: number;
}

/** Shared metadata returned for a trashed note or notebook. */
interface TrashListItemBase {
	/** Stable native note or notebook ID. */
	id: string;
	/** Display-safe title, with encrypted titles masked by Joplin. */
	title: string;
	/** Original native parent notebook ID, or an empty string when rooted at the top level. */
	parent_id: string;
	/** Native deletion time in milliseconds. */
	deleted_time: number;
	/** Native update time in milliseconds. */
	updated_time: number;
}

/** Metadata for one trashed note. */
export interface TrashNoteListItem extends TrashListItemBase {
	/** Identifies a note rather than a notebook. */
	type: 'note';
	/** Native numeric conflict flag. */
	is_conflict: number;
}

/** Metadata for one trashed notebook. */
export interface TrashNotebookListItem extends TrashListItemBase {
	/** Identifies a notebook rather than a note. */
	type: 'notebook';
}

/** One page of native Trash items in stable deletion order. */
export interface ListTrashResult {
	/** Trashed notes and notebooks on this page. */
	items: (TrashNoteListItem|TrashNotebookListItem)[];
	/** Whether another trashed item exists after this page. */
	hasMore: boolean;
}

/** Identifies one trashed native note or notebook to restore. */
export interface RestoreTrashItemRequest {
	/** Stable lowercase 32-character Joplin item ID. */
	id: string;
}

/** Result of restoring one native note or notebook. */
export interface RestoreTrashItemResult {
	/** Stable ID of the restored native item. */
	id: string;
	/** Parent notebook after native restore handling; empty for the root. */
	parent_id: string;
	/** Confirms the item was restored. */
	restored: true;
}

/** A typed request failure raised before any restore mutation begins. */
export class HeadlessTrashRequestError extends JoplinError {
	/** Creates a stable pre-mutation error for the headless Trash contract. */
	public constructor(message: string, code: 'invalid_trash_input'|'trash_item_not_found'|'trash_item_not_deleted') {
		super(message, code);
	}
}

/** Shape of the allowlisted SQL row used to build the public Trash listing. */
interface TrashListRow {
	/** Stable native note or notebook ID. */
	id: string;
	/** Whether this row represents a note or notebook. */
	type: 'note'|'notebook';
	/** Stored item title, masked before it is returned when encrypted. */
	title: string;
	/** Native encryption flag used by BaseItem.displayTitle. */
	encryption_applied: number;
	/** Original native parent notebook ID. */
	parent_id: string;
	/** Native deletion time in milliseconds. */
	deleted_time: number;
	/** Native update time in milliseconds. */
	updated_time: number;
	/** Native numeric conflict flag for notes; null for notebooks. */
	is_conflict: number|null;
}

/** Default to the first page when no page is requested. */
const defaultPage = 1;
/** Match the headless sidecar's documented default page size. */
const defaultLimit = 20;

/** Raise the stable error used for malformed Trash requests and pagination. */
const invalidRequest = (message: string): never => {
	throw new HeadlessTrashRequestError(message, 'invalid_trash_input');
};

/** Reject non-object requests and properties outside the action's fixed contract. */
const validateRequest = (value: unknown, allowedFields: string[]): void => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRequest('A Trash request is required.');
	if (Object.keys(value).some(key => !allowedFields.includes(key))) invalidRequest('The Trash request contains an unsupported property.');
};

/** Validate a stable lowercase 32-character Joplin item ID. */
const validateId = (value: unknown): void => {
	if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) invalidRequest('A valid Trash item ID is required.');
};

/** Load a note or notebook's deletion metadata and reject absent or active items. */
const requireDeletedItem = async (itemType: ModelType.Note|ModelType.Folder, id: string): Promise<NoteEntity|FolderEntity> => {
	const item = itemType === ModelType.Note
		? await Note.load(id, { fields: ['id', 'deleted_time'] })
		: await Folder.load(id, { fields: ['id', 'deleted_time'] });

	if (!item || item.id !== id) {
		throw new HeadlessTrashRequestError('The requested Trash item was not found.', 'trash_item_not_found');
	}
	if (!(item.deleted_time > 0)) {
		throw new HeadlessTrashRequestError('The requested item is not in the Trash.', 'trash_item_not_deleted');
	}
	return item;
};

/** Read-only listing and native restore actions for headless Trash access. */
export default class HeadlessTrash {
	/** Lists deleted notes and notebooks in stable deletion order with safe pagination. */
	public static async listTrash(request: ListTrashRequest): Promise<ListTrashResult> {
		validateRequest(request, ['page', 'limit']);

		const page = request.page ?? defaultPage;
		const limit = request.limit ?? defaultLimit;
		if (!Number.isSafeInteger(page) || page < 1) invalidRequest('page must be a positive integer.');
		if (!Number.isSafeInteger(limit) || limit < 1) invalidRequest('limit must be a positive integer.');
		const offset = (page - 1) * limit;
		if (!Number.isSafeInteger(offset)) invalidRequest('The requested page is too large.');
		const fetchLimit = limit + 1;
		if (!Number.isSafeInteger(fetchLimit) || !Number.isSafeInteger(offset + fetchLimit)) invalidRequest('The requested page is too large.');

		const rows = await Note.modelSelectAll<TrashListRow>(`
			SELECT id, type, title, encryption_applied, parent_id, deleted_time, updated_time, is_conflict
			FROM (
				SELECT id, 'note' AS type, title, encryption_applied, parent_id, deleted_time, updated_time, is_conflict
				FROM notes
				WHERE deleted_time > 0
				UNION ALL
				SELECT id, 'notebook' AS type, title, encryption_applied, parent_id, deleted_time, updated_time, NULL AS is_conflict
				FROM folders
				WHERE deleted_time > 0
			)
			ORDER BY deleted_time DESC, type ASC, id ASC
			LIMIT ? OFFSET ?`, [fetchLimit, offset]);

		return {
			items: rows.slice(0, limit).map(row => {
				const shared = {
					id: row.id,
					title: BaseItem.displayTitle(row),
					parent_id: row.parent_id,
					deleted_time: row.deleted_time,
					updated_time: row.updated_time,
				};
				if (row.type === 'note') return { ...shared, type: 'note', is_conflict: row.is_conflict! };
				return { ...shared, type: 'notebook' };
			}),
			hasMore: rows.length > limit,
		};
	}

	/** Restores one deleted note through the native restore service's default behavior. */
	public static async restoreNote(request: RestoreTrashItemRequest): Promise<RestoreTrashItemResult> {
		validateRequest(request, ['id']);
		validateId(request.id);
		await requireDeletedItem(ModelType.Note, request.id);

		// Keep restore-service errors outside the preflight error path: the native mutation may already have run.
		await restoreItems(ModelType.Note, [request.id]);
		const restored = await Note.load(request.id, { fields: ['id', 'parent_id'] });
		if (!restored || restored.id !== request.id) throw new Error('The restored note could not be reloaded.');
		return { id: request.id, parent_id: restored.parent_id ?? '', restored: true };
	}

	/** Restores one deleted notebook and its deleted descendants through native defaults. */
	public static async restoreNotebook(request: RestoreTrashItemRequest): Promise<RestoreTrashItemResult> {
		validateRequest(request, ['id']);
		validateId(request.id);
		await requireDeletedItem(ModelType.Folder, request.id);

		// Notebook restore recursively restores descendants inside restoreItems.
		await restoreItems(ModelType.Folder, [request.id]);
		const restored = await Folder.load(request.id, { fields: ['id', 'parent_id'] });
		if (!restored || restored.id !== request.id) throw new Error('The restored notebook could not be reloaded.');
		return { id: request.id, parent_id: restored.parent_id ?? '', restored: true };
	}
}
