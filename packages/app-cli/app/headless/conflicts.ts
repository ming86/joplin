import JoplinError from '@joplin/lib/JoplinError';
import HeadlessConflicts, {
	ListConflictsRequest,
	ReadConflictRequest,
} from '@joplin/lib/services/HeadlessConflicts';

/** Typed failures that can be returned as stable, unapplied inspection results. */
const knownErrorCodes = new Set([
	'invalid_conflict_input',
	'conflict_not_found',
]);

/** Return known service failures in the headless action error envelope. */
async function withKnownServiceErrors<T>(operation: ()=> Promise<T>): Promise<T | { error: { code: string; message: string; applied: false } }> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof JoplinError) || typeof error.code !== 'string' || !knownErrorCodes.has(error.code)) throw error;
		return { error: { code: error.code, message: error.message, applied: false } };
	}
}

/** The fixed read-only conflict actions exposed by the headless service. */
export default function createHeadlessConflictActions() {
	return Object.assign(Object.create(null), {
		/** List active and readable native conflict copies. */
		listConflicts: (input: ListConflictsRequest) => withKnownServiceErrors(() => HeadlessConflicts.listConflicts(input)),
		/** Read one conflict copy and report the availability of its original note. */
		readConflict: (input: ReadConflictRequest) => withKnownServiceErrors(() => HeadlessConflicts.readConflict(input)),
	});
}
