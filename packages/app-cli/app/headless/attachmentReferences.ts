import JoplinError from '@joplin/lib/JoplinError';
import HeadlessAttachmentReferences, { ListAttachmentNotesRequest } from '@joplin/lib/services/HeadlessAttachmentReferences';

/** Stable validation error that can be returned without exposing database details. */
const knownErrorCodes = new Set(['invalid_attachment_reference_input']);

/** Return known request failures in the read-only action error envelope. */
async function withKnownServiceErrors<T>(operation: ()=> Promise<T>): Promise<T | { error: { code: string; message: string; applied: false } }> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof JoplinError) || typeof error.code !== 'string' || !knownErrorCodes.has(error.code)) throw error;
		return { error: { code: error.code, message: error.message, applied: false } };
	}
}

/** The fixed read-only attachment-reference action exposed by the private headless service. */
export default function createHeadlessAttachmentReferenceActions() {
	return Object.assign(Object.create(null), {
		/** Find readable notes whose current saved bodies reference the supplied attachment ID. */
		listAttachmentNotes: (input: ListAttachmentNotesRequest) => withKnownServiceErrors(() => HeadlessAttachmentReferences.listAttachmentNotes(input)),
	});
}
