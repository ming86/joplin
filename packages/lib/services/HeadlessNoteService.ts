import BaseModel, { UserSideValidationError } from '../BaseModel';
import JoplinError from '../JoplinError';
import Folder from '../models/Folder';
import Note from '../models/Note';
import Revision, { RevisionContent, RevisionReconstruction } from '../models/Revision';
import applyBodyPatch from './HeadlessNotePatch';
import { NoteEntity, RevisionEntity, SqlQuery } from './database/types';

/** Supported edits applied against a caller's native revision of the current note. */
export interface HeadlessNoteChanges {
	/** Replace the title verbatim. */
	title?: string;
	/** Replace the body verbatim in the note's existing markup format. */
	body?: string;
	/** Apply exact contextual line hunks to the body read at the supplied native revision. */
	body_patch?: string;
	/** Append literal text when body is not supplied. */
	append?: string;
	/** Prepend literal text when body is not supplied. */
	prepend?: string;
	/** Replace exactly one literal occurrence when body is not supplied. */
	replace_text?: { find: string; replace: string };
	/** Move the note to this readable notebook. */
	notebook_id?: string;
	/** Convert the note to or from a to-do. A type change clears its prior due and completion values. */
	is_todo?: boolean;
	/** Set the to-do due date in Unix milliseconds, or 0 to clear it. */
	todo_due?: number;
	/** Set or clear to-do completion. */
	todo_completed?: boolean;
	/** Replace the source URL, or use an empty string to clear it. */
	source_url?: string;
}

/** A revision-checked request to update a note through its ordinary save path. */
export interface HeadlessNoteUpdate {
	/** The existing note to edit. */
	id: string;
	/** Native revision representing the note state the caller read. */
	base_revision_id: string;
	/** The supported partial edit. */
	changes: HeadlessNoteChanges;
}

/** A current note snapshot paired with native history of exactly its tracked content. */
export type HeadlessNoteRead = NoteEntity & {
	/** Native revision corresponding to the returned snapshot. */
	revision_id: string;
};

/** The saved snapshot and native history references for a conditional edit. */
export type HeadlessNoteUpdateResult = HeadlessNoteRead & {
	/** Native revision representing the content immediately before the edit. */
	previous_revision_id: string;
	/** Whether a supported editable value changed. */
	changed: boolean;
};

/** A native revision prepared for the same transaction as its note mutation. */
interface PreparedCapture {
	/** Existing or newly prepared native revision entity. */
	revision: RevisionEntity;
	/** The complete normalized snapshot represented by revision. */
	content: RevisionContent;
	/** An insert when the snapshot changed, otherwise no SQL. */
	queries: SqlQuery[];
	/** Read-only assertions protecting the original persisted head and reconstructed ancestry. */
	checks: SqlQuery[];
}

/** A persisted native head together with its exact reconstruction dependencies. */
interface CaptureParent extends RevisionReconstruction {
	/** The current native head, or null when history does not exist yet. */
	revision: RevisionEntity;
}

/** Validate the same stable lowercase IDs as native item validation. */
function requireId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new JoplinError('A valid item ID is required.', 'invalid_note_input');
}

/** Reject ineligible current notes without exposing their content. */
async function loadReadableNote(id: string): Promise<NoteEntity> {
	const note = await Note.load(id);
	if (!note || note.encryption_applied !== 0 || note.deleted_time || note.is_locked) {
		throw new JoplinError('The note is unavailable.', 'note_unavailable');
	}
	return note;
}

/** Prepare a native insert using standard model IDs, timestamps and field filtering. */
async function prepareCapture(note: NoteEntity, previous?: PreparedCapture, source?: CaptureParent): Promise<PreparedCapture> {
	const service = Note.revisionService();
	if (!previous && !source) {
		const revision = await Revision.latestRevision(BaseModel.TYPE_NOTE, note.id);
		// An unlocked snapshot starts fresh after locked history. Protect the persisted head
		// without reading its ciphertext ancestry; ordinary diff parents still reconstruct strictly.
		const reconstruction: RevisionReconstruction = revision && !service.startsNewRevisionChain(note, revision)
			? await Revision.reconstructWithDependencies(revision)
			: { content: null, revisions: revision ? [revision] : [] };
		source = { revision, ...reconstruction };
	}
	const parent = previous?.revision || source?.revision;
	const parentContent = previous?.content || source?.content;
	const checks = previous?.checks || revisionChecks(note.id, source);
	const content = service.noteRevisionContent(note);
	const draft = service.prepareNoteRevision(note, parent, parentContent, Date.now());
	if (!draft) return { revision: parent, content, queries: [], checks };
	const query = Revision.saveQuery(Revision.filter(draft), Revision.modOptions({ isNew: true }));
	return { revision: { ...draft, ...query.modObject, encryption_applied: 0 }, content, queries: [query], checks };
}

/** Assert a loaded persisted row still exists with every captured column unchanged. */
function snapshotCheck(model: typeof Note | typeof Revision, item: NoteEntity | RevisionEntity): SqlQuery {
	const fields = model.fieldNames().filter(field => Object.prototype.hasOwnProperty.call(item, field));
	return {
		sql: `SELECT 1 FROM ${model.tableName()} WHERE ${fields.map(field => `${model.db().escapeField(field)} IS ?`).join(' AND ')}`,
		params: fields.map(field => (item as Record<string, unknown>)[field]),
		expectedRowCount: 1,
	};
}

/** Protect both an existing ancestry and the absence of history before the first capture. */
function revisionChecks(noteId: string, source: CaptureParent): SqlQuery[] {
	return [{
		sql: 'SELECT 1 WHERE (SELECT id FROM revisions WHERE item_type = ? AND item_id = ? ORDER BY item_updated_time DESC LIMIT 1) IS ?',
		params: [BaseModel.TYPE_NOTE, noteId, source.revision?.id || null],
		expectedRowCount: 1,
	}, ...source.revisions.map(revision => snapshotCheck(Revision, revision))];
}

/** Compare the state callers can edit, including markup and the to-do fields they read. */
function matchesBase(note: NoteEntity, base: RevisionContent): boolean {
	if (note.title !== base.title || note.body !== base.body) return false;
	for (const field of ['parent_id', 'is_todo', 'todo_due', 'todo_completed', 'markup_language', 'source_url'] as const) {
		const historical = field === 'markup_language' ? base.metadata[field] ?? 1 : field === 'source_url' ? base.metadata[field] ?? '' : base.metadata[field];
		if (note[field] !== historical) return false;
	}
	return true;
}

/** Check the supported edit object before any capture can persist history. */
function validateChanges(changes: HeadlessNoteChanges) {
	if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new JoplinError('An edit object is required.', 'invalid_note_input');
	const supported = ['title', 'body', 'body_patch', 'append', 'prepend', 'replace_text', 'notebook_id', 'is_todo', 'todo_due', 'todo_completed', 'source_url'];
	if (Object.keys(changes).some(key => !supported.includes(key))) throw new JoplinError('Unsupported note property.', 'unsupported_note_property');
	for (const field of ['title', 'body', 'body_patch', 'append', 'prepend', 'notebook_id', 'source_url'] as const) {
		if (changes[field] !== undefined && typeof changes[field] !== 'string') throw new JoplinError('Note text fields must be strings.', 'invalid_note_input');
	}
	const hasOtherBodyEdit = changes.body !== undefined || changes.prepend !== undefined || changes.append !== undefined || changes.replace_text !== undefined;
	if (changes.body_patch !== undefined && hasOtherBodyEdit) {
		throw new JoplinError('A contextual body patch cannot be combined with another body edit mode.', 'note_patch_body_conflict');
	}
	if (changes.is_todo !== undefined && typeof changes.is_todo !== 'boolean') throw new JoplinError('To-do type must be a boolean.', 'invalid_note_input');
	if (changes.todo_due !== undefined && (typeof changes.todo_due !== 'number' || !Number.isInteger(changes.todo_due))) {
		throw new JoplinError('A due date must be an integer timestamp.', 'invalid_note_input');
	}
	if (changes.todo_completed !== undefined && typeof changes.todo_completed !== 'boolean') throw new JoplinError('To-do completion must be a boolean.', 'invalid_note_input');
	if (changes.replace_text !== undefined) {
		const replacement = changes.replace_text;
		if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement) || Object.keys(replacement).some(key => !['find', 'replace'].includes(key)) || typeof replacement.find !== 'string' || typeof replacement.replace !== 'string') {
			throw new JoplinError('A literal find and replacement are required.', 'invalid_note_input');
		}
		if (!replacement.find) throw new JoplinError('Replacement text to find must not be empty.', 'replace_text_empty_find');
	}
}

/** Translate expected save failures without exposing stored values or database details. */
function rethrowSaveError(error: Error & { code?: string }): never {
	if (error.code === 'conditionalSaveConflict') throw new JoplinError('The note or its revision history changed during the operation.', 'note_conflict');
	if (error instanceof UserSideValidationError) throw new JoplinError('The note edit failed validation.', 'validation_error');
	if (error.code === 'isReadOnly') throw new JoplinError('The note or destination notebook is read-only.', 'note_read_only');
	throw error;
}

/** Apply one body edit mode plus notebook, to-do and source URL changes to the checked snapshot. */
async function editPatch(note: NoteEntity, changes: HeadlessNoteChanges): Promise<NoteEntity> {
	const patch: NoteEntity = {};
	if (changes.title !== undefined) patch.title = changes.title;
	if (changes.body_patch !== undefined) {
		const body = applyBodyPatch(note.body || '', changes.body_patch);
		if (body !== note.body) patch.body = body;
	} else if (changes.body !== undefined) {
		patch.body = changes.body;
	} else {
		let body = note.body || '';
		if (changes.prepend) body = changes.prepend + body;
		if (changes.append) body += changes.append;
		if (changes.replace_text) {
			const { find, replace } = changes.replace_text;
			const start = body.indexOf(find);
			if (start < 0) throw new JoplinError('Replacement text was not found.', 'replace_text_not_found');
			if (body.indexOf(find, start + 1) >= 0) throw new JoplinError('Replacement text occurs more than once.', 'replace_text_ambiguous');
			body = body.slice(0, start) + replace + body.slice(start + find.length);
		}
		if (body !== note.body) patch.body = body;
	}
	if (changes.notebook_id !== undefined) {
		requireId(changes.notebook_id);
		const folder = await Folder.load(changes.notebook_id);
		if (!folder || folder.encryption_applied !== 0 || folder.deleted_time) throw new JoplinError('The notebook is unavailable.', 'notebook_unavailable');
		patch.parent_id = folder.id;
	}
	let todoCompleted = note.todo_completed || 0;
	if (changes.is_todo !== undefined) {
		const isTodo = changes.is_todo ? 1 : 0;
		if (isTodo !== note.is_todo) {
			patch.is_todo = isTodo;
			// Match Note.changeNoteType: switching type clears both previous to-do values.
			// Explicit due/completion edits below are applied after this reset.
			patch.todo_due = 0;
			patch.todo_completed = 0;
			todoCompleted = 0;
		}
	}
	if (changes.todo_due !== undefined) patch.todo_due = changes.todo_due;
	if (changes.todo_completed !== undefined) {
		// Repeating the current boolean state is unchanged. A type switch uses its reset
		// completion value so an explicit true gets a fresh completion timestamp.
		patch.todo_completed = changes.todo_completed ? todoCompleted || Date.now() : 0;
	}
	if (changes.source_url !== undefined) patch.source_url = changes.source_url;
	return patch;
}

/** Read one eligible snapshot, creating native history only when its tracked state is unrecorded. */
export async function readNote(id: string): Promise<HeadlessNoteRead> {
	requireId(id);
	return Note.revisionService().withRevisionLock(async () => {
		const note = await loadReadableNote(id);
		const capture = await prepareCapture(note);
		try {
			await Note.db().transactionExecBatch([snapshotCheck(Note, note), ...capture.checks, ...capture.queries]);
		} catch (error) {
			rethrowSaveError(error);
		}
		return { ...note, revision_id: capture.revision.id };
	});
}

/** Save a native-revision-checked edit and both history snapshots in one database transaction. */
export async function updateNote(input: HeadlessNoteUpdate): Promise<HeadlessNoteUpdateResult> {
	requireId(input?.id);
	requireId(input?.base_revision_id);
	validateChanges(input.changes);
	return Note.revisionService().withRevisionLock(async () => {
		const note = await loadReadableNote(input.id);
		const baseRevision = await Revision.load(input.base_revision_id);
		if (!baseRevision || baseRevision.item_type !== BaseModel.TYPE_NOTE || baseRevision.item_id !== note.id) {
			throw new JoplinError('The base revision does not belong to this note or is no longer retained.', 'note_conflict');
		}
		const latestRevision = await Revision.latestRevision(BaseModel.TYPE_NOTE, note.id);
		if (latestRevision?.id !== baseRevision.id) throw new JoplinError('The note revision has changed since the supplied revision.', 'note_conflict');
		const reconstructed = await Revision.reconstructWithDependencies(baseRevision);
		if (!matchesBase(note, reconstructed.content)) throw new JoplinError('The note has changed since the supplied revision.', 'note_conflict');
		const patch = await editPatch(note, input.changes);
		const changed = Object.keys(patch).some(field => (patch as Record<string, unknown>)[field] !== (note as Record<string, unknown>)[field]);
		const before = await prepareCapture(note, null, { revision: baseRevision, ...reconstructed });
		if (!changed) {
			// Verify the current snapshot even for an unchanged request. This preserves both note
			// timestamps and ItemChange state while guarding any newly needed history insert.
			try {
				await Note.db().transactionExecBatch([snapshotCheck(Note, note), ...before.checks, ...before.queries]);
			} catch (error) {
				rethrowSaveError(error);
			}
			return { ...note, revision_id: before.revision.id, previous_revision_id: before.revision.id, changed: false };
		}

		// Use the same automatic timestamps as Note.save, while preparing the complete post-edit
		// snapshot before persistence so its native revision can commit with the guarded UPDATE.
		const now = Date.now();
		const mutation = { ...patch, id: note.id, updated_time: now, user_updated_time: now };
		const updated = { ...note, ...mutation };
		const after = await prepareCapture(updated, before);
		try {
			await Note.save(mutation, {
				autoTimestamp: false,
				userSideValidation: true,
				expectedItem: note,
				nextQueries: [...before.checks, ...before.queries, ...after.queries],
			});
		} catch (error) {
			rethrowSaveError(error);
		}
		return { ...updated, revision_id: after.revision.id, previous_revision_id: before.revision.id, changed: true };
	});
}

/** Native-history-aware note operations used by the fixed headless action catalog. */
export default class HeadlessNoteService {
	/** Read a snapshot paired with its native revision ID. */
	public static readNote = readNote;
	/** Atomically save a conditional edit and its native history. */
	public static updateNote = updateNote;
}
