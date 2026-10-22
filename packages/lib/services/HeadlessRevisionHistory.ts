import { createPatch } from 'diff';
import fastDeepEqual = require('fast-deep-equal');
import { ModelType } from '../BaseModel';
import JoplinError from '../JoplinError';
import Note from '../models/Note';
import Revision from '../models/Revision';
import { MarkupLanguage } from '../../renderer';
import { RevisionEntity } from './database/types';
import HeadlessNoteService from './HeadlessNoteService';
import isNoteLockEnabled from './noteLock/isNoteLockEnabled';

/** A page request for one note's retained native revisions. */
export interface ListNoteRevisionsRequest {
	/** Stable Joplin note ID. */
	note_id: string;
	/** One-based page number; defaults to 1. */
	page?: number;
	/** Number of revisions to return; defaults to 50. */
	limit?: number;
}

/** A retained revision's stable identity and native capture-order details. */
export interface NoteRevisionListItem {
	/** Stable native revision ID. */
	revision_id: string;
	/** Native capture ordering time, not necessarily the original edit time. */
	captured_time: number;
	/** Stable ID of the parent revision, or null for the first revision. */
	parent_revision_id: string|null;
}

/** One page of retained revisions, ordered newest first. */
export interface ListNoteRevisionsResult {
	/** Revisions on this page. */
	items: NoteRevisionListItem[];
	/** Whether another visible revision exists after this page. */
	hasMore: boolean;
}

/** Identifies one retained revision belonging to a note. */
export interface ReadNoteRevisionRequest {
	/** Stable Joplin note ID. */
	note_id: string;
	/** Stable native revision ID. */
	revision_id: string;
}

/** A reconstructed historical note snapshot. */
export interface ReadNoteRevisionResult {
	/** Stable Joplin note ID. */
	note_id: string;
	/** Stable native revision ID. */
	revision_id: string;
	/** Native capture ordering time, not necessarily the original edit time. */
	captured_time: number;
	/** Historical note title. */
	title: string;
	/** Historical note body in its original markup format. */
	body: string;
	/** Metadata retained by native note revision history. */
	metadata: Record<string, unknown>;
}

/** Identifies the source revision and optionally a second retained revision. */
export interface CompareNoteRevisionsRequest {
	/** Stable Joplin note ID. */
	note_id: string;
	/** Stable native revision ID to compare from. */
	from_revision_id: string;
	/** Stable native target revision ID; when omitted, capture the current note. */
	to_revision_id?: string;
}

/** A metadata value with explicit presence so absent and null remain distinct. */
export type MetadataValue = { present: false } | { present: true; value: unknown };

/** One tracked metadata field that differs between snapshots. */
export interface MetadataChange {
	/** Native tracked metadata property name. */
	field: string;
	/** Source value, including whether the field existed. */
	from: MetadataValue;
	/** Target value, including whether the field exists. */
	to: MetadataValue;
}

/** Text patches and structured metadata changes between two note snapshots. */
export interface CompareNoteRevisionsResult {
	/** Stable Joplin note ID. */
	note_id: string;
	/** Stable native source revision ID. */
	from_revision_id: string;
	/** Stable native target revision ID, including for a captured current note. */
	to_revision_id: string;
	/** True when the target was captured from the current note during this request. */
	to_current: boolean;
	/** Unified diff for the title, or an empty string if unchanged. */
	title_diff: string;
	/** Unified diff for the body, or an empty string if unchanged. */
	body_diff: string;
	/** Sorted changes to native tracked metadata. */
	metadata_changes: MetadataChange[];
}

/** Reconstructed title, body, and tracked metadata shared by comparison logic. */
interface RevisionSnapshot {
	/** Historical note title. */
	title: string;
	/** Historical note body. */
	body: string;
	/** Historical native tracked metadata. */
	metadata: Record<string, unknown>;
}

/** Default to the first page when no page is requested. */
const defaultPage = 1;
/** Keep the default page small while allowing callers to request larger pages. */
const defaultLimit = 50;

/** Raise the stable error used for invalid query parameters. */
const invalidRequest = (message: string): never => {
	throw new JoplinError(message, 'revision_invalid_request');
};

/** Raise the stable error used when a revision is absent or belongs elsewhere. */
const notFound = (): never => {
	throw new JoplinError('The requested note revision was not found.', 'revision_not_found');
};

/** Validate a stable lowercase 32-character Joplin ID. */
const validateId: (value: unknown, name: string) => asserts value is string = (value, name) => {
	if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) invalidRequest(`Missing or invalid ${name}.`);
};

/** Read a revision's stable ID, treating malformed stored history as broken. */
const revisionId = (revision: RevisionEntity): string => {
	if (typeof revision.id !== 'string' || !revision.id) {
		throw new JoplinError('A revision is missing its stable ID.', 'revision_history_broken');
	}
	return revision.id;
};

/** Read the native capture ordering time, treating malformed history as broken. */
const capturedTime = (revision: RevisionEntity): number => {
	if (typeof revision.item_updated_time !== 'number' || !Number.isFinite(revision.item_updated_time)) {
		throw new JoplinError('A revision is missing its capture time.', 'revision_history_broken');
	}
	return revision.item_updated_time;
};

/** Match the legacy history reconstruction fallback used by native restore. */
const withDefaultMarkupLanguage = (metadata: Record<string, unknown>): Record<string, unknown> => {
	const output = { ...metadata };
	if (!('markup_language' in output)) output.markup_language = MarkupLanguage.Markdown;
	return output;
};

/** Reconstruct a revision and normalize metadata for older snapshots. */
const snapshotFromRevision = async (revision: RevisionEntity): Promise<RevisionSnapshot> => {
	const reconstructed = await Revision.mergeDiffsStrict(revision);
	return {
		title: reconstructed.title,
		body: reconstructed.body,
		metadata: withDefaultMarkupLanguage(reconstructed.metadata),
	};
};

/** Produce a unified text diff, returning an empty string for unchanged text. */
const textDiff = (field: string, from: string, to: string, fromLabel: string, toLabel: string): string => {
	if (from === to) return '';
	return createPatch(field, from, to, fromLabel, toLabel, { context: 3 });
};

/** Represent a metadata field while preserving the difference between absent and null. */
const metadataValue = (metadata: Record<string, unknown>, field: string): MetadataValue => {
	if (!Object.prototype.hasOwnProperty.call(metadata, field)) return { present: false };
	return { present: true, value: metadata[field] };
};

/** Compare tracked metadata as structured values and sort changes by field name. */
const compareMetadata = (from: Record<string, unknown>, to: Record<string, unknown>): MetadataChange[] => {
	const fields = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
	const changes: MetadataChange[] = [];
	for (const field of fields) {
		const fromPresent = Object.prototype.hasOwnProperty.call(from, field);
		const toPresent = Object.prototype.hasOwnProperty.call(to, field);
		if (fromPresent === toPresent && (!fromPresent || fastDeepEqual(from[field], to[field]))) continue;
		changes.push({
			field,
			from: metadataValue(from, field),
			to: metadataValue(to, field),
		});
	}
	return changes;
};

/** A history row with the stable ID and capture time required by the public API. */
type StoredRevision = RevisionEntity & { id: string; item_updated_time: number };

/** Native read-only revision history queries for headless note actions. */
export default class HeadlessRevisionHistory {
	/** Lists retained note revisions, newest first, without requiring the source note to still exist. */
	public static async listNoteRevisions(request: ListNoteRevisionsRequest): Promise<ListNoteRevisionsResult> {
		if (!request) invalidRequest('A request is required.');
		validateId(request.note_id, 'note_id');

		const page = request.page ?? defaultPage;
		const limit = request.limit ?? defaultLimit;
		if (!Number.isSafeInteger(page) || page < 1) invalidRequest('page must be a positive integer.');
		if (!Number.isSafeInteger(limit) || limit < 1) invalidRequest('limit must be a positive integer.');
		const offset = (page - 1) * limit;
		if (!Number.isSafeInteger(offset)) invalidRequest('The requested page is too large.');
		const end = offset + limit;
		if (!Number.isSafeInteger(end)) invalidRequest('The requested page is too large.');

		return Note.revisionService().withRevisionLock(async () => {
			const revisions = await Revision.allByType(ModelType.Note, request.note_id);
			const visibleRevisions = isNoteLockEnabled() ? revisions.filter(revision => !revision.is_locked) : revisions;
			const newestFirst = visibleRevisions.slice().reverse();
			const pageRevisions = newestFirst.slice(offset, end);
			return {
				items: pageRevisions.map(revision => ({
					revision_id: revisionId(revision),
					captured_time: capturedTime(revision),
					parent_revision_id: revision.parent_id || null,
				})),
				hasMore: end < newestFirst.length,
			};
		});
	}

	/** Reconstructs one retained revision using its complete native parent chain. */
	public static async readNoteRevision(request: ReadNoteRevisionRequest): Promise<ReadNoteRevisionResult> {
		if (!request) invalidRequest('A request is required.');
		validateId(request.note_id, 'note_id');
		validateId(request.revision_id, 'revision_id');

		return Note.revisionService().withRevisionLock(async () => {
			const revision = await this.revisionForNote_(request.note_id, request.revision_id);
			const snapshot = await snapshotFromRevision(revision);
			return {
				note_id: request.note_id,
				revision_id: revision.id,
				captured_time: capturedTime(revision),
				title: snapshot.title,
				body: snapshot.body,
				metadata: snapshot.metadata,
			};
		});
	}

	/** Compares any two retained snapshots, or a retained snapshot with the current note when the target is omitted. */
	public static async compareNoteRevisions(request: CompareNoteRevisionsRequest): Promise<CompareNoteRevisionsResult> {
		if (!request) invalidRequest('A request is required.');
		validateId(request.note_id, 'note_id');
		validateId(request.from_revision_id, 'from_revision_id');
		if (request.to_revision_id !== undefined) validateId(request.to_revision_id, 'to_revision_id');

		const from = await Note.revisionService().withRevisionLock(async () => {
			const revision = await this.revisionForNote_(request.note_id, request.from_revision_id);
			return snapshotFromRevision(revision);
		});

		// readNote captures the current snapshot and takes the revision lock internally. Keep it outside the lock above.
		const currentNote = request.to_revision_id ? null : await HeadlessNoteService.readNote(request.note_id);
		const toRevisionId = request.to_revision_id ?? currentNote?.revision_id;
		if (!toRevisionId) {
			throw new JoplinError('The current note snapshot has no native revision ID.', 'revision_history_broken');
		}
		const to = await Note.revisionService().withRevisionLock(async () => {
			const revision = await this.revisionForNote_(request.note_id, toRevisionId);
			return snapshotFromRevision(revision);
		});

		return {
			note_id: request.note_id,
			from_revision_id: request.from_revision_id,
			to_revision_id: toRevisionId,
			to_current: request.to_revision_id === undefined,
			title_diff: textDiff('title', from.title, to.title, `revision ${request.from_revision_id}`, request.to_revision_id ? `revision ${request.to_revision_id}` : 'current note'),
			body_diff: textDiff('body', from.body, to.body, `revision ${request.from_revision_id}`, request.to_revision_id ? `revision ${request.to_revision_id}` : 'current note'),
			metadata_changes: compareMetadata(from.metadata, to.metadata),
		};
	}

	/** Load and validate a revision's ownership and required capture fields. */
	private static async revisionForNote_(noteId: string, requestedRevisionId: string): Promise<StoredRevision> {
		const revision = await Revision.load(requestedRevisionId);
		if (!revision || revision.item_type !== ModelType.Note || revision.item_id !== noteId) notFound();
		revisionId(revision);
		capturedTime(revision);
		return revision as StoredRevision;
	}
}
