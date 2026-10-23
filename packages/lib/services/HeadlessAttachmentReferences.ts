import JoplinError from '../JoplinError';
import Note from '../models/Note';
import type { NoteEntity } from './database/types';

/** Pagination options for listing readable notes that currently reference one attachment ID. */
export interface ListAttachmentNotesRequest {
	/** Stable lowercase Joplin ID used by an attachment reference. */
	id: string;
	/** One-based page number; defaults to 1. */
	page?: number;
	/** Number of matching notes to return; defaults to 20. */
	limit?: number;
}

/** Allowlisted note metadata returned for one attachment reference. */
export interface AttachmentNoteReference {
	/** Stable native note ID. */
	id: string;
	/** Note title. */
	title: string;
	/** Parent notebook ID, or an empty string when the note has no parent. */
	parent_id: string;
	/** Native creation time in milliseconds. */
	created_time: number;
	/** Native update time in milliseconds. */
	updated_time: number;
	/** Native deletion time in milliseconds; nonzero notes are in Trash. */
	deleted_time: number;
	/** Native numeric conflict flag. */
	is_conflict: number;
}

/** One page of matching note metadata and whether another match exists. */
export interface ListAttachmentNotesResult {
	/** Attachment ID whose saved-body references were requested. */
	attachment_id: string;
	/** Readable notes whose current saved bodies reference the requested ID. */
	items: AttachmentNoteReference[];
	/** Whether another matching note exists after this page. */
	hasMore: boolean;
}

/** Number of note rows fetched at a time while parsing saved bodies. */
const noteBatchSize = 100;
/** Default to the first page when no page is requested. */
const defaultPage = 1;
/** Keep the sidecar list response bounded by default. */
const defaultLimit = 20;

/** Raise a stable validation error for malformed attachment-reference requests. */
const invalidRequest = (message: string): never => {
	throw new JoplinError(message, 'invalid_attachment_reference_input');
};

/** Reject non-object requests and fields outside the fixed read-only contract. */
function validateRequest(value: unknown): asserts value is ListAttachmentNotesRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRequest('An attachment-reference request is required.');
	if (Object.keys(value).some(key => !['id', 'page', 'limit'].includes(key))) invalidRequest('The attachment-reference request contains an unsupported property.');

	const request = value as Partial<ListAttachmentNotesRequest>;
	if (typeof request.id !== 'string' || !/^[a-f0-9]{32}$/.test(request.id)) invalidRequest('A valid attachment ID is required.');

	const page = request.page ?? defaultPage;
	const limit = request.limit ?? defaultLimit;
	if (!Number.isSafeInteger(page) || page < 1) invalidRequest('page must be a positive integer.');
	if (!Number.isSafeInteger(limit) || limit < 1) invalidRequest('limit must be a positive integer.');
	const offset = (page - 1) * limit;
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit + 1) || !Number.isSafeInteger(offset + limit + 1)) {
		invalidRequest('The requested page is too large.');
	}
}

/** Copy only the public note fields and provide native defaults for nullable legacy values. */
function referenceMetadata(note: NoteEntity): AttachmentNoteReference {
	return {
		id: note.id!,
		title: note.title ?? '',
		parent_id: note.parent_id ?? '',
		created_time: note.created_time ?? 0,
		updated_time: note.updated_time ?? 0,
		deleted_time: note.deleted_time ?? 0,
		is_conflict: note.is_conflict ?? 0,
	};
}

/** Read-only queries over the current saved note bodies, independent of the asynchronous resource index. */
export default class HeadlessAttachmentReferences {
	/**
	 * Lists saved-body references, including Trash and conflict copies, without returning note bodies.
	 * Encrypted and locked notes are excluded because their saved bodies are not readable.
	 */
	public static async listAttachmentNotes(request: ListAttachmentNotesRequest): Promise<ListAttachmentNotesResult> {
		validateRequest(request);

		const page = request.page ?? defaultPage;
		const limit = request.limit ?? defaultLimit;
		const offset = (page - 1) * limit;
		const matches: AttachmentNoteReference[] = [];
		let matchedCount = 0;
		let lastId = '';

		// Walk current decrypted and unlocked note bodies in stable ID order. Encrypted and
		// locked notes are outside this readable lookup because their saved bodies are opaque.
		while (matches.length <= limit) {
			const notes = await Note.modelSelectAll<NoteEntity>(`
				SELECT id, title, parent_id, created_time, updated_time, deleted_time, is_conflict, body
				FROM notes
				WHERE id > ? AND encryption_applied = 0 AND is_locked = 0
				ORDER BY id ASC
				LIMIT ?`, [lastId, noteBatchSize]);
			if (!notes.length) break;

			for (const note of notes) {
				lastId = note.id!;
				if (!Note.linkedItemIds(note.body ?? '').includes(request.id)) continue;

				if (matchedCount >= offset) matches.push(referenceMetadata(note));
				matchedCount++;
				if (matches.length > limit) break;
			}
		}

		return {
			attachment_id: request.id,
			items: matches.slice(0, limit),
			hasMore: matches.length > limit,
		};
	}
}
