import { revisionConflictOutputSchemas } from './revision-conflict-output-schemas.mjs';
import { maintenanceAttachmentOutputSchemas } from './maintenance-attachment-output-schemas.mjs';

/** Describe an output record without closing fields retained from backend records. */
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
/** Describe a fixed public result whose keys are part of its exact contract. */
const exactObject = (properties, required = Object.keys(properties)) => ({ ...object(properties, required), additionalProperties: false });
/** Describe a list of values with the same output contract. */
const array = items => ({ type: 'array', items });
/** Text supplied by the service or native Joplin backend. */
const string = { type: 'string' };
/** Numeric native field or calculated value. */
const number = { type: 'number' };
/** Boolean flag in the public tool result. */
const boolean = { type: 'boolean' };
/** Nullable text, including a missing readable notebook label. */
const nullableString = { type: ['string', 'null'] };
/** Time in Unix epoch milliseconds, or null before the event is recorded. */
const nullableTime = { type: ['number', 'null'], description: 'Unix epoch milliseconds, or null before this event is recorded.' };
/** Native timestamp format shared by note and process fields. */
const time = { type: 'number', description: 'Unix epoch milliseconds.' };
/** Authenticated Joplin profile email, or null when identity is unavailable. */
const accountEmail = { ...nullableString, description: 'Authenticated Joplin account email, or null when unavailable.' };

/** Fields retained from a native note; only its identity is always required. */
const noteProperties = {
	id: string, parent_id: string, title: string, body: string,
	created_time: time, updated_time: time,
	is_todo: { type: 'number', description: 'Native to-do flag, encoded as 0 or 1.' },
	todo_completed: { type: 'number', description: 'Completion time in Unix epoch milliseconds, or 0 while open.' },
	markup_language: { type: 'number', description: 'Native Joplin markup language value.' },
	encryption_applied: number, deleted_time: time, is_locked: number, accountEmail,
};
/** Note list metadata with the body replaced by a short preview. */
const { body: _body, ...summaryProperties } = noteProperties;
/** Preview offsets and lengths use JavaScript UTF-16 code units. */
const summary = object({ ...summaryProperties,
	preview: { type: 'string', description: 'First 320 UTF-16 code units of the note body.' },
	bodyTruncated: boolean,
}, ['id', 'accountEmail', 'preview', 'bodyTruncated']);
/** Notebook metadata normalized by the account service. */
const notebook = object({ id: string, title: string, parent_id: { ...nullableString, description: 'Parent notebook id, or null for a top-level notebook.' } });
/** Complete notebook list rows include counts of readable, non-deleted notes. */
const countedNotebook = object({ ...notebook.properties, note_count: number });
/** Semantic engine state; progress fields exist only when supplied by the engine. */
const semantic = object({
	state: { type: 'string', enum: ['unavailable', 'indexing', 'ready', 'degraded'] },
	reason: string, embeddingSpaceId: string, generation: number, initialScanComplete: boolean,
	pendingNotes: number, indexedNotes: number, failedNotes: number,
	lastReconciledAt: nullableTime, providerRetryAt: nullableTime,
	usage: object({ inputTokens: number, preparedBytes: { type: 'number', description: 'Prepared embedding input size in bytes.' }, successfulRequests: number }),
}, ['state']);
/** Available counters from the latest in-memory sync report. */
const syncCounters = object(Object.fromEntries([
	'itemConflict', 'noteConflict', 'resourceConflict', 'createRemote', 'updateRemote', 'deleteRemote',
	'createLocal', 'updateLocal', 'deleteLocal', 'fetchingTotal', 'fetchingProcessed',
].map(name => [name, number])), []);
/** The latest sync report can be absent before the first report arrives. */
const syncReport = object({
	state: { type: ['string', 'null'], enum: ['idle', 'in_progress', null], description: 'Last report state; may remain in_progress after sync completes.' },
	startTime: nullableTime, completedTime: nullableTime, counters: syncCounters, errorCount: number,
});
/** Current process status combined with the account and semantic index state. */
const status = object({
	accountEmail: { ...nullableString, description: 'Joplin account email, or null when unavailable.' },
	accountId: { type: 'string', description: 'Local account binding ID selected by the registry.' },
	semantic, observedAt: time, serviceStartedAt: time,
	sync: object({ running: boolean, pending: boolean, report: { anyOf: [syncReport, { type: 'null' }] } }),
	decryption: object({
		state: { type: ['string', 'null'], enum: ['idle', 'started', null] },
		batch: { description: 'Last reported batch while started; may still describe the preceding run until progress arrives.', anyOf: [object({ itemIndex: { type: 'number', description: 'Zero-based index within the reported batch.' }, itemCount: number }), { type: 'null' }] },
		missingMasterKey: boolean, disabledItemCount: number,
	}),
});
/** A single Desktop-style search row, optionally enriched for semantic modes. */
const searchResult = exactObject({
	id: string, title: string, notebook_id: nullableString, updated_time: time, snippet: string,
	provenance: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'] }, score: number, semanticExcerpt: string,
	chunk: exactObject({ ordinal: number, start: { type: 'number', description: 'Start offset in UTF-8 bytes.' }, end: { type: 'number', description: 'End offset in UTF-8 bytes.' }, offsetUnit: { const: 'utf8-byte', type: 'string' } }),
}, ['id', 'notebook_id', 'snippet']);
/** Body slicing fields common to read_note and its numeric legacy alias. */
const readProperties = {
	...noteProperties, revision_id: string, previous_revision_id: nullableString, changed: boolean,
	notebook_id: nullableString, notebook_title: nullableString, tags: array(string),
	body_length: { type: 'number', description: 'Full body length in UTF-16 code units.' },
	body_offset: { type: 'number', description: 'Start offset of the returned body in UTF-16 code units.' },
	body_returned_chars: { type: 'number', description: 'Returned body length in UTF-16 code units.' },
	has_more: boolean,
	offset: { type: 'number', description: 'Legacy alias for body_offset in UTF-16 code units.' },
	nextOffset: { type: ['number', 'null'], description: 'Next UTF-16 code-unit offset, or null when the full body has been returned.' },
	totalLength: { type: 'number', description: 'Legacy full body length in UTF-16 code units.' },
	offsetUnit: { type: 'string', const: 'utf16-code-unit' },
};
/** Required fields synthesized by the read tool in addition to the service identity. */
const readRequired = ['id', 'accountEmail', 'revision_id', 'body', 'notebook_id', 'notebook_title', 'tags', 'is_todo', 'todo_completed', 'body_length', 'body_offset', 'body_returned_chars', 'has_more', 'offset', 'nextOffset', 'totalLength', 'offsetUnit'];
/** Success contracts for the core tools, including the defined Desktop semantic result. */
const coreOutputSchemas = {
	get_status: status,
	list_notebooks: exactObject({ notebooks: array(countedNotebook) }),
	list_tags: object({ tags: array(object({ id: string, title: string })) }),
	list_notes: object({
		accountEmail: { ...accountEmail, description: 'Authenticated Joplin account email when the service supplies page-level account attribution; null when unavailable.' },
		items: array(summary), hasMore: boolean,
	}, ['items', 'hasMore']),
	search_notes: exactObject({
		accountEmail, requestedMode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'] },
		executedMode: { type: ['string', 'null'], enum: ['keyword', 'semantic', 'hybrid', null] }, semantic,
		hasMore: boolean,
		results: array(searchResult),
		total: { type: 'integer', description: 'Exact eligible keyword match count when supported by the backend.' },
		candidateWindow: { type: 'number', description: 'Number of candidates considered from each search source.' }, truncated: boolean, notebookId: string,
	}, ['accountEmail', 'requestedMode', 'executedMode', 'semantic', 'hasMore', 'results']),
	semantic_search_notes: { ...object({ results: array(object({
		note_id: string, title: nullableString, notebook_id: nullableString,
		chunk_index: { type: 'number', description: 'Chunk index within the source note.' }, chunk_text: string,
		score: { type: 'number', description: 'Similarity score rounded to three decimal places.' },
	})), total: { type: 'number', description: 'Number of returned matching chunks.' } }), description: 'On success, returns ranked note chunks with source ids, matching text and similarity scores.' },
	read_note: object({ ...readProperties, is_todo: boolean, todo_completed: boolean }, readRequired),
	get_note: object(readProperties, readRequired),
	create_note: exactObject({ id: string, title: string, notebook_id: string }),
	update_note: exactObject({ id: string, updated_time: time, revision_id: string, previous_revision_id: nullableString, changed: boolean }),
	delete_note: object({ id: string, trashed: { type: 'boolean', const: true } }),
	create_notebook: object({
		...notebook.properties,
		parent_id: { type: 'string', description: 'Native parent notebook id, or an empty string for a top-level notebook.' },
		encryption_applied: number, deleted_time: time,
	}, ['id', 'title', 'parent_id']),
	manage_tags: object({ note_id: string, added: array(string), removed: array(string), tags: array(string) }),
};

/** Every existing structured tool error, including validation-only responses. */
const errorSchema = object({ error: object({
	code: { type: 'string', description: 'Stable service error code, or operation_failed for an unexpected failure.' },
	message: { type: 'string', description: 'Safe public detail when supplied for this tool and error.' },
	outcomeUnknown: { type: 'boolean', description: 'Whether a write may have committed; omitted for argument validation errors.' },
	action: { type: 'string', description: 'Inspection advice included when the write outcome is unknown.' },
}, ['code']) });
/** Exhaustive catalog mapping; missing entries are registration errors. */
const successSchemas = { ...coreOutputSchemas, ...revisionConflictOutputSchemas, ...maintenanceAttachmentOutputSchemas };

/** Return the existing success or structured error contract for one registered tool. */
export function getToolOutputSchema(name) {
	const success = successSchemas[name];
	if (!success) throw new Error(`Missing output schema for MCP tool: ${name}`);
	return { type: 'object', anyOf: [success, errorSchema] };
}
