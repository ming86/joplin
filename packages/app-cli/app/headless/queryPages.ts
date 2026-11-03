import JoplinError from '@joplin/lib/JoplinError';
import HeadlessSearchService, { ListScopedNoteBodiesRequest, SearchNotesRequest } from '@joplin/lib/services/HeadlessSearchService';

/** Return request validation failures while preserving unexpected native failures. */
async function withKnownQueryErrors<T>(operation: ()=> Promise<T>): Promise<T | { error: { code: string; message: string; applied: false } }> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof JoplinError) || error.code !== 'invalid_headless_query_input') throw error;
		return { error: { code: error.code, message: error.message, applied: false } };
	}
}

/** Fixed read-only query page actions exposed by the private headless API. */
export default function createHeadlessQueryPageActions() {
	return Object.assign(Object.create(null), {
		/** Return a keyword page and its exact readable total from one native search. */
		searchNotes: (input: SearchNotesRequest) => withKnownQueryErrors(() => HeadlessSearchService.searchNotes(input)),
		/** Enumerate current readable bodies in an exact resolved notebook/note union. */
		listScopedNoteBodies: (input: ListScopedNoteBodiesRequest) => withKnownQueryErrors(() => HeadlessSearchService.listScopedNoteBodies(input)),
	});
}
