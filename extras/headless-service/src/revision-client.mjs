import { ServiceError, pagination, requireValue, identifier } from './errors.mjs';
import { requestDiagnostics, withDiagnostics } from './diagnostics.mjs';

/** Recognize plain JSON records from the fixed headless API. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate a native Joplin revision identifier. */
const revisionId = value => {
	requireValue(typeof value === 'string' && /^[a-f0-9]{32}$/.test(value), 'invalid_revision_id');
	return value;
};
/** Error codes and fixed safe messages returned by native revision actions. */
const knownCoreErrors = new Map([
	['revision_invalid_request', 'The revision request is invalid.'],
	['revision_not_found', 'The requested note revision was not found.'],
	['revision_forbidden', 'This note revision cannot be accessed.'],
	['revision_encrypted', 'This note revision is encrypted.'],
	['revision_history_broken', 'The note revision history could not be reconstructed.'],
	['note_conflict', 'The note changed after it was read. Read the current note and review it before retrying.'],
	['note_unavailable', 'The note is not available.'],
	['note_read_only', 'The note or destination notebook is read-only.'],
	['notebook_unavailable', 'The destination notebook is not available.'],
	['unsupported_note_property', 'The note update contains an unsupported property.'],
	['invalid_note_input', 'The note update is invalid.'],
	['replace_text_empty_find', 'replace_text.find must not be empty.'],
	['replace_text_not_found', 'The text to replace was not found.'],
	['replace_text_ambiguous', 'The text to replace must occur exactly once.'],
	['validation_error', 'The request did not pass validation.'],
]);

/** JSON-safe values retained in the native revision metadata snapshot. */
function jsonValue(value) {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(jsonValue);
	return record(value) && Object.values(value).every(jsonValue);
}

/** Validate a native note snapshot and retain only known Joplin fields. */
function noteResult(data, expectedId) {
	const fields = [
		'id', 'parent_id', 'title', 'body', 'created_time', 'updated_time', 'is_todo', 'todo_due', 'todo_completed',
		'source', 'source_application', 'source_url',
		'markup_language', 'encryption_applied', 'deleted_time', 'is_locked', 'revision_id', 'previous_revision_id', 'changed',
	];
	requireValue(record(data) && data.id === expectedId, 'invalid_backend_response');
	identifier(data.id);
	requireValue(typeof data.revision_id === 'string' && /^[a-f0-9]{32}$/.test(data.revision_id), 'invalid_backend_response');
	for (const key of fields) {
		if (!Object.hasOwn(data, key)) continue;
		if (['id', 'parent_id', 'title', 'body', 'source', 'source_application', 'source_url'].includes(key)) requireValue(typeof data[key] === 'string', 'invalid_backend_response');
		else if (key === 'revision_id') requireValue(typeof data[key] === 'string' && /^[a-f0-9]{32}$/.test(data[key]), 'invalid_backend_response');
		else if (key === 'previous_revision_id') requireValue(data[key] === null || typeof data[key] === 'string' && /^[a-f0-9]{32}$/.test(data[key]), 'invalid_backend_response');
		else if (key === 'changed') requireValue(typeof data[key] === 'boolean', 'invalid_backend_response');
		else if (key === 'todo_due') requireValue(Number.isInteger(data[key]), 'invalid_backend_response');
		else requireValue(typeof data[key] === 'number' && Number.isFinite(data[key]), 'invalid_backend_response');
	}
	return Object.fromEntries(fields.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
}

/** Validate and allowlist the compact row returned by revision-history pages. */
function revisionSummary(data) {
	requireValue(record(data) && typeof data.revision_id === 'string' && /^[a-f0-9]{32}$/.test(data.revision_id)
		&& Number.isSafeInteger(data.captured_time) && data.captured_time >= 0
		&& (data.parent_revision_id === null || typeof data.parent_revision_id === 'string' && /^[a-f0-9]{32}$/.test(data.parent_revision_id)), 'invalid_backend_response');
	return { revision_id: data.revision_id, captured_time: data.captured_time, parent_revision_id: data.parent_revision_id };
}

/** Validate and allowlist one reconstructed historical note snapshot. */
function revisionSnapshot(data, noteId, requestedRevisionId) {
	requireValue(record(data) && data.note_id === noteId && data.revision_id === requestedRevisionId
		&& Number.isSafeInteger(data.captured_time) && data.captured_time >= 0
		&& typeof data.title === 'string' && typeof data.body === 'string'
		&& record(data.metadata) && jsonValue(data.metadata), 'invalid_backend_response');
	return {
		note_id: data.note_id,
		revision_id: data.revision_id,
		captured_time: data.captured_time,
		title: data.title,
		body: data.body,
		metadata: structuredClone(data.metadata),
	};
}

/** Validate one before/after value in a native metadata change. */
function metadataChange(data) {
	const side = value => {
		requireValue(record(value) && typeof value.present === 'boolean'
			&& (value.present ? Object.hasOwn(value, 'value') && jsonValue(value.value) : !Object.hasOwn(value, 'value')), 'invalid_backend_response');
		return value.present ? { present: true, value: structuredClone(value.value) } : { present: false };
	};
	requireValue(record(data) && typeof data.field === 'string' && data.field.length > 0, 'invalid_backend_response');
	return { field: data.field, from: side(data.from), to: side(data.to) };
}

/** Validate and allowlist a native revision comparison. */
function comparisonResult(data, noteId, fromRevisionId, toRevisionId) {
	requireValue(record(data) && data.note_id === noteId && data.from_revision_id === fromRevisionId
		&& typeof data.to_revision_id === 'string' && /^[a-f0-9]{32}$/.test(data.to_revision_id)
		&& (toRevisionId === undefined || data.to_revision_id === toRevisionId)
		&& typeof data.title_diff === 'string' && typeof data.body_diff === 'string'
		&& Number.isSafeInteger(data.from_body_total_line_count) && data.from_body_total_line_count >= 1
		&& Number.isSafeInteger(data.to_body_total_line_count) && data.to_body_total_line_count >= 1
		&& typeof data.to_current === 'boolean'
		&& Array.isArray(data.metadata_changes), 'invalid_backend_response');
	return {
		note_id: data.note_id,
		from_revision_id: data.from_revision_id,
		to_revision_id: data.to_revision_id,
		to_current: data.to_current,
		title_diff: data.title_diff,
		body_diff: data.body_diff,
		from_body_total_line_count: data.from_body_total_line_count,
		to_body_total_line_count: data.to_body_total_line_count,
		metadata_changes: data.metadata_changes.map(metadataChange),
	};
}

/** Unwrap native errors only when the fixed error code certifies no write was applied. */
function actionResult(data, writing) {
	if (!record(data) || !Object.hasOwn(data, 'error')) return data;
	const failure = data.error;
	if (record(failure) && failure.applied === false && knownCoreErrors.has(failure.code)) {
		throw new ServiceError(failure.code, false, knownCoreErrors.get(failure.code));
	}
	if (writing) throw new ServiceError('write_outcome_unknown', true);
	throw new ServiceError('invalid_backend_response');
}

/** Fixed-action client for native note revision operations on the headless API. */
export function createRevisionClient(request) {
	requireValue(typeof request === 'function');
	const post = (action, values, signal, writeOperation = false) => request(
		'services/headless', {}, 'POST', { action, ...values }, signal, { writeOperation },
	);
	/** Keep native action failures recognizable while adding fixed validation context. */
	function validatedActionResult(response, action, writing, startedAt) {
		try { return actionResult(response, writing); }
		catch (error) {
			if (!(error instanceof ServiceError)) throw error;
			throw withDiagnostics(error, requestDiagnostics({
				method: 'POST', path: 'services/headless', operation: action,
				elapsedMs: Date.now() - startedAt, stage: 'validation',
			}));
		}
	}

	return Object.freeze({
		/** Read a note and capture its current revision, classifying a lost capture reply as uncertain. */
		async readNoteWithRevision(id, signal) {
			identifier(id);
			const startedAt = Date.now();
			const data = validatedActionResult(await post('readNote', { id }, signal, true), 'readNote', true, startedAt);
			try { return noteResult(data, id); }
			catch (error) {
				throw new ServiceError('write_outcome_unknown', true, undefined, {
					cause: error,
					diagnostics: requestDiagnostics({
						method: 'POST', path: 'services/headless', operation: 'readNote',
						elapsedMs: Date.now() - startedAt, stage: 'validation',
					}),
				});
			}
		},
		/** Update against the caller's native revision ID; never retry a write. */
		async updateNoteWithRevision(id, input, signal) {
			identifier(id);
			requireValue(record(input), 'invalid_note_input');
			const allowed = ['base_revision_id', 'title', 'body', 'append', 'prepend', 'replace_text', 'notebook_id', 'is_todo', 'todo_due', 'todo_completed', 'source_url'];
			requireValue(Object.keys(input).every(key => allowed.includes(key)), 'unsupported_note_property');
			requireValue(Object.hasOwn(input, 'base_revision_id'), 'base_revision_required');
			revisionId(input.base_revision_id);
			const changes = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'base_revision_id'));
			requireValue(Object.keys(changes).length > 0, 'empty_note_update');
			for (const key of ['title', 'body', 'append', 'prepend']) {
				if (Object.hasOwn(changes, key)) requireValue(typeof changes[key] === 'string', 'invalid_note_input');
			}
			if (Object.hasOwn(changes, 'notebook_id')) identifier(changes.notebook_id);
			if (Object.hasOwn(changes, 'is_todo')) requireValue(typeof changes.is_todo === 'boolean', 'invalid_note_input');
			if (Object.hasOwn(changes, 'todo_due')) requireValue(Number.isInteger(changes.todo_due), 'invalid_note_input');
			if (Object.hasOwn(changes, 'todo_completed')) requireValue(typeof changes.todo_completed === 'boolean', 'invalid_note_input');
			if (Object.hasOwn(changes, 'source_url')) requireValue(typeof changes.source_url === 'string', 'invalid_note_input');
			if (Object.hasOwn(changes, 'replace_text')) {
				const replace = changes.replace_text;
				requireValue(record(replace) && Object.keys(replace).length === 2
					&& Object.hasOwn(replace, 'find') && Object.hasOwn(replace, 'replace')
					&& typeof replace.find === 'string' && typeof replace.replace === 'string', 'invalid_note_input');
			}

			const startedAt = Date.now();
			const data = validatedActionResult(await post('updateNote', { id, base_revision_id: input.base_revision_id, changes }, signal, true), 'updateNote', true, startedAt);
			try {
				const result = noteResult(data, id);
				requireValue(typeof result.changed === 'boolean'
					&& (result.previous_revision_id === null || typeof result.previous_revision_id === 'string'), 'invalid_backend_response');
				return result;
			} catch (error) {
				// The core may have committed before returning a malformed success payload.
				throw new ServiceError('write_outcome_unknown', true, undefined, {
					cause: error,
					diagnostics: requestDiagnostics({
						method: 'POST', path: 'services/headless', operation: 'updateNote',
						elapsedMs: Date.now() - startedAt, stage: 'validation',
					}),
				});
			}
		},
		/** Return one native revision-history page. */
		async listNoteRevisions(input, signal) {
			requireValue(record(input) && Object.keys(input).every(key => ['note_id', 'page', 'limit'].includes(key)), 'invalid_revision_input');
			const noteId = identifier(input.note_id);
			const page = pagination({ page: input.page, limit: input.limit });
			const startedAt = Date.now();
			const response = await post('listNoteRevisions', { note_id: noteId, ...page }, signal);
			const data = validatedActionResult(response, 'listNoteRevisions', false, startedAt);
			try {
				requireValue(record(data) && Array.isArray(data.items) && typeof data.hasMore === 'boolean', 'invalid_backend_response');
				return { items: data.items.map(revisionSummary), hasMore: data.hasMore };
			} catch (error) {
				throw withDiagnostics(error, requestDiagnostics({
					method: 'POST', path: 'services/headless', operation: 'listNoteRevisions',
					elapsedMs: Date.now() - startedAt, stage: 'validation',
				}));
			}
		},
		/** Read an immutable historical snapshot without requiring a live note. */
		async readNoteRevision(input, signal) {
			requireValue(record(input) && Object.keys(input).length === 2
				&& Object.hasOwn(input, 'note_id') && Object.hasOwn(input, 'revision_id'), 'invalid_revision_input');
			const noteId = identifier(input.note_id);
			const id = revisionId(input.revision_id);
			const startedAt = Date.now();
			const response = await post('readNoteRevision', { note_id: noteId, revision_id: id }, signal);
			const data = validatedActionResult(response, 'readNoteRevision', false, startedAt);
			try { return revisionSnapshot(data, noteId, id); }
			catch (error) {
				throw withDiagnostics(error, requestDiagnostics({
					method: 'POST', path: 'services/headless', operation: 'readNoteRevision',
					elapsedMs: Date.now() - startedAt, stage: 'validation',
				}));
			}
		},
		/** Compare two native snapshots, using the latest revision when the destination is omitted. */
		async compareNoteRevisions(input, signal) {
			requireValue(record(input) && Object.keys(input).every(key => ['note_id', 'from_revision_id', 'to_revision_id'].includes(key))
				&& Object.hasOwn(input, 'note_id') && Object.hasOwn(input, 'from_revision_id'), 'invalid_revision_input');
			const noteId = identifier(input.note_id);
			const fromId = revisionId(input.from_revision_id);
			const toId = input.to_revision_id === undefined ? undefined : revisionId(input.to_revision_id);
			const startedAt = Date.now();
			const response = await post('compareNoteRevisions', {
				note_id: noteId,
				from_revision_id: fromId,
				...(toId === undefined ? {} : { to_revision_id: toId }),
			}, signal);
			const data = validatedActionResult(response, 'compareNoteRevisions', false, startedAt);
			try { return comparisonResult(data, noteId, fromId, toId); }
			catch (error) {
				throw withDiagnostics(error, requestDiagnostics({
					method: 'POST', path: 'services/headless', operation: 'compareNoteRevisions',
					elapsedMs: Date.now() - startedAt, stage: 'validation',
				}));
			}
		},
	});
}
