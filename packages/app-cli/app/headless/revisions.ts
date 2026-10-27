import JoplinError from '@joplin/lib/JoplinError';
import HeadlessNoteService, { HeadlessNoteUpdate } from '@joplin/lib/services/HeadlessNoteService';
import HeadlessRevisionHistory, {
	CompareNoteRevisionsRequest,
	ListNoteRevisionsRequest,
	ListRevisionsRequest,
	ReadNoteRevisionRequest,
} from '@joplin/lib/services/HeadlessRevisionHistory';

/** Errors with a stable public contract that can safely be returned as failed actions. */
const knownErrorCodes = new Set([
	'invalid_note_input',
	'unsupported_note_property',
	'note_unavailable',
	'notebook_unavailable',
	'note_conflict',
	'replace_text_empty_find',
	'replace_text_not_found',
	'replace_text_ambiguous',
	'note_patch_invalid',
	'note_patch_not_found',
	'note_patch_ambiguous',
	'note_patch_order',
	'note_patch_body_conflict',
	'revision_invalid_request',
	'revision_not_found',
	'revision_forbidden',
	'revision_encrypted',
	'revision_history_broken',
	'validation_error',
	'note_read_only',
]);

/** Return expected typed service failures in the stable action response envelope. */
async function withKnownServiceErrors<T>(operation: ()=> Promise<T>): Promise<T | { error: { code: string; message: string; applied: false } }> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof JoplinError) || typeof error.code !== 'string' || !knownErrorCodes.has(error.code)) throw error;
		return { error: { code: error.code, message: error.message, applied: false } };
	}
}

/** Validate combined-list transport values once before the native query uses them. */
function validateListRevisions(input: ListRevisionsRequest): void {
	/** Reject malformed requests through the stable revision action envelope. */
	const invalid = (message: string): never => { throw new JoplinError(message, 'revision_invalid_request'); };
	if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('A revision query object is required.');
	const fields = ['note_ids', 'notebook_ids', 'include_descendants', 'since', 'until', 'page', 'limit'];
	if (Object.keys(input).some(key => !fields.includes(key))) invalid('Unsupported revision query property.');
	for (const field of ['note_ids', 'notebook_ids'] as const) {
		const ids = input[field];
		if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)))) invalid(`${field} must contain valid note or notebook IDs.`);
	}
	if (input.include_descendants !== undefined && typeof input.include_descendants !== 'boolean') invalid('include_descendants must be a boolean.');
	for (const field of ['since', 'until'] as const) {
		if (input[field] !== undefined && !Number.isSafeInteger(input[field])) invalid(`${field} must be a safe integer timestamp.`);
	}
	const page = input.page === undefined ? 1 : input.page;
	const limit = input.limit === undefined ? 20 : input.limit;
	if (!Number.isSafeInteger(page) || page < 1) invalid('page must be a positive safe integer.');
	if (!Number.isSafeInteger(limit) || limit < 1) invalid('limit must be a positive safe integer.');
	const offset = (page - 1) * limit;
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + limit + 1)) invalid('The requested page is too large.');
}

/** The fixed revision and conditional note actions exposed by the headless service. */
export function createHeadlessRevisionActions() {
	return Object.assign(Object.create(null), {
		/** Read a note with the native revision used to guard its next edit. */
		readNote: (input: { id: string }) => withKnownServiceErrors(() => HeadlessNoteService.readNote(input.id)),
		/** Apply a conditional note edit through its native save and history transaction. */
		updateNote: (input: HeadlessNoteUpdate) => withKnownServiceErrors(() => HeadlessNoteService.updateNote(input)),
		/** List retained native revisions for one note. */
		listNoteRevisions: (input: ListNoteRevisionsRequest) => withKnownServiceErrors(() => HeadlessRevisionHistory.listNoteRevisions(input)),
		/** List combined retained summaries using explicit notes or current notebook membership. */
		listRevisions: (input: ListRevisionsRequest) => withKnownServiceErrors(async () => {
			validateListRevisions(input);
			return HeadlessRevisionHistory.listRevisions(input);
		}),
		/** Read one reconstructed native revision. */
		readNoteRevision: (input: ReadNoteRevisionRequest) => withKnownServiceErrors(() => HeadlessRevisionHistory.readNoteRevision(input)),
		/** Compare two retained revisions, or a retained revision with the current note. */
		compareNoteRevisions: (input: CompareNoteRevisionsRequest) => withKnownServiceErrors(() => HeadlessRevisionHistory.compareNoteRevisions(input)),
	});
}
