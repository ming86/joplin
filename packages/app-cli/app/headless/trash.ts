import HeadlessTrash, {
	HeadlessTrashRequestError,
	ListTrashRequest,
	RestoreTrashItemRequest,
} from '@joplin/lib/services/HeadlessTrash';

/** Return only known pre-mutation Trash failures in the headless error envelope. */
async function withTrashPreflightErrors<T>(operation: ()=> Promise<T>): Promise<T | { error: { code: string; message: string; applied: false } }> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof HeadlessTrashRequestError)) throw error;
		return { error: { code: String(error.code), message: error.message, applied: false } };
	}
}

/** The fixed native Trash actions exposed by the headless service. */
export default function createHeadlessTrashActions() {
	return Object.assign(Object.create(null), {
		/** List deleted notes and notebooks with native conflict and encrypted-title metadata. */
		listTrash: (input: ListTrashRequest) => withTrashPreflightErrors(() => HeadlessTrash.listTrash(input)),
		/** Restore one deleted note through the native Trash restore service. */
		restoreNote: (input: RestoreTrashItemRequest) => withTrashPreflightErrors(() => HeadlessTrash.restoreNote(input)),
		/** Restore one deleted notebook and its deleted descendants through the native service. */
		restoreNotebook: (input: RestoreTrashItemRequest) => withTrashPreflightErrors(() => HeadlessTrash.restoreNotebook(input)),
	});
}
