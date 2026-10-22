import { ServiceError, pagination, requireValue } from './errors.mjs';

/** Recognize plain JSON records from the fixed headless API. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate one native Joplin note or notebook ID. */
const nativeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
/** Validate a conflict identifier without exposing backend selectors. */
const conflictId = value => {
	requireValue(nativeId(value), 'invalid_conflict_input');
	return value;
};
/** Validate a conflict-side ID; null is reserved for a side with no linked note. */
const nullableId = value => value === null || nativeId(value);
/** Native relation columns use an empty string, not null, when no ID is linked. */
const nativeRelationId = value => value === '' || nativeId(value);
/** Fixed public messages for the native conflict inspection actions. */
const knownCoreErrors = new Map([
	['conflict_not_found', 'The requested device-local sync conflict was not found.'],
	['invalid_conflict_input', 'The conflict request is invalid.'],
]);

/** Validate and retain one compact device-local conflict row. */
function conflictSummary(data) {
	requireValue(record(data)
		&& nativeId(data.id)
		&& typeof data.title === 'string'
		&& nativeRelationId(data.conflict_original_id)
		&& Number.isSafeInteger(data.created_time) && data.created_time >= 0
		&& Number.isSafeInteger(data.updated_time) && data.updated_time >= 0, 'invalid_backend_response');
	return {
		id: data.id,
		title: data.title,
		conflict_original_id: data.conflict_original_id,
		created_time: data.created_time,
		updated_time: data.updated_time,
	};
}

/** Validate and retain the native snapshot fields returned for an available side. */
function conflictSnapshot(data, expectedId) {
	requireValue(record(data)
		&& data.id === expectedId
		&& nativeRelationId(data.parent_id)
		&& typeof data.title === 'string'
		&& typeof data.body === 'string'
		&& Number.isSafeInteger(data.created_time) && data.created_time >= 0
		&& Number.isSafeInteger(data.updated_time) && data.updated_time >= 0
		&& (data.is_todo === 0 || data.is_todo === 1)
		&& Number.isSafeInteger(data.todo_completed)
		&& Number.isSafeInteger(data.markup_language)
		&& (data.is_conflict === 0 || data.is_conflict === 1)
		&& nativeRelationId(data.conflict_original_id), 'invalid_backend_response');
	return {
		id: data.id,
		parent_id: data.parent_id,
		title: data.title,
		body: data.body,
		created_time: data.created_time,
		updated_time: data.updated_time,
		is_todo: data.is_todo,
		todo_completed: data.todo_completed,
		markup_language: data.markup_language,
		is_conflict: data.is_conflict,
		conflict_original_id: data.conflict_original_id,
	};
}

/** Validate one side and suppress any note content for unavailable states. */
function conflictSide(data) {
	const statuses = ['available', 'missing', 'trashed', 'encrypted', 'locked', 'unlinked'];
	requireValue(record(data) && nullableId(data.id) && statuses.includes(data.status), 'invalid_backend_response');
	if (data.status !== 'available') return { id: data.id, status: data.status };
	requireValue(data.id !== null, 'invalid_backend_response');
	return { id: data.id, status: data.status, note: conflictSnapshot(data.note, data.id) };
}

/** Translate only documented, unapplied native errors into safe service errors. */
function actionResult(data) {
	if (!record(data) || !Object.hasOwn(data, 'error')) return data;
	const failure = data.error;
	if (record(failure) && failure.applied === false && typeof failure.message === 'string' && knownCoreErrors.has(failure.code)) {
		throw new ServiceError(failure.code, false, knownCoreErrors.get(failure.code));
	}
	throw new ServiceError('invalid_backend_response');
}

/** Fixed-action client for read-only native sync conflict inspection. */
export function createConflictClient(request) {
	requireValue(typeof request === 'function');
	const post = (action, values, signal) => request(
		'services/headless', {}, 'POST', { action, ...values }, signal, { writeOperation: false },
	);

	return Object.freeze({
		/** List one page of native device-local conflict notes. */
		async listConflicts(input = {}, signal) {
			requireValue(record(input) && Object.keys(input).every(key => ['page', 'limit'].includes(key)), 'invalid_conflict_input');
			let page;
			try { page = pagination({ page: input.page, limit: input.limit }); }
			catch { throw new ServiceError('invalid_conflict_input'); }
			const data = actionResult(await post('listConflicts', page, signal));
			requireValue(record(data) && Array.isArray(data.items) && typeof data.hasMore === 'boolean', 'invalid_backend_response');
			return { items: data.items.map(conflictSummary), hasMore: data.hasMore };
		},
		/** Read both current sides of one device-local sync conflict. */
		async readConflict(input, signal) {
			requireValue(record(input) && Object.keys(input).length === 1 && Object.hasOwn(input, 'id'), 'invalid_conflict_input');
			const id = conflictId(input.id);
			const data = actionResult(await post('readConflict', { id }, signal));
			requireValue(record(data) && Object.hasOwn(data, 'conflict') && Object.hasOwn(data, 'original'), 'invalid_backend_response');
			return { conflict: conflictSide(data.conflict), original: conflictSide(data.original) };
		},
	});
}
