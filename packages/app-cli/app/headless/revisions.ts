import JoplinError from '@joplin/lib/JoplinError';
import HeadlessNoteService, { HeadlessNoteUpdate } from '@joplin/lib/services/HeadlessNoteService';
import HeadlessRevisionHistory, {
	CompareNoteRevisionsRequest,
	ListNoteRevisionsRequest,
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

/** The fixed revision and conditional note actions exposed by the headless service. */
export function createHeadlessRevisionActions() {
	return Object.assign(Object.create(null), {
		/** Read a note with the native revision used to guard its next edit. */
		readNote: (input: { id: string }) => withKnownServiceErrors(() => HeadlessNoteService.readNote(input.id)),
		/** Apply a conditional note edit through its native save and history transaction. */
		updateNote: (input: HeadlessNoteUpdate) => withKnownServiceErrors(() => HeadlessNoteService.updateNote(input)),
		/** List retained native revisions for one note. */
		listNoteRevisions: (input: ListNoteRevisionsRequest) => withKnownServiceErrors(() => HeadlessRevisionHistory.listNoteRevisions(input)),
		/** Read one reconstructed native revision. */
		readNoteRevision: (input: ReadNoteRevisionRequest) => withKnownServiceErrors(() => HeadlessRevisionHistory.readNoteRevision(input)),
		/** Compare two retained revisions, or a retained revision with the current note. */
		compareNoteRevisions: (input: CompareNoteRevisionsRequest) => withKnownServiceErrors(() => HeadlessRevisionHistory.compareNoteRevisions(input)),
	});
}
