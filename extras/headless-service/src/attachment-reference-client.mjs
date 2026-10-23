import { ServiceError, pagination, requireValue } from './errors.mjs';

/** Recognize plain JSON records from the fixed headless API. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate one native Joplin item identifier. */
const nativeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
/** Native relation columns use an empty string when no parent notebook is linked. */
const nativeRelationId = value => value === '' || nativeId(value);
/** Fixed safe message for the native attachment-reference action. */
const knownCoreErrors = new Map([
	['invalid_attachment_reference_input', 'The attachment reference request is invalid.'],
]);

/** Validate and retain one compact current-note reference. */
function referenceSummary(data) {
	requireValue(record(data)
		&& nativeId(data.id)
		&& typeof data.title === 'string'
		&& nativeRelationId(data.parent_id)
		&& Number.isSafeInteger(data.created_time) && data.created_time >= 0
		&& Number.isSafeInteger(data.updated_time) && data.updated_time >= 0
		&& Number.isSafeInteger(data.deleted_time) && data.deleted_time >= 0
		&& (data.is_conflict === 0 || data.is_conflict === 1), 'invalid_backend_response');
	return {
		id: data.id,
		title: data.title,
		parent_id: data.parent_id,
		created_time: data.created_time,
		updated_time: data.updated_time,
		deleted_time: data.deleted_time,
		is_conflict: data.is_conflict,
	};
}

/** Translate only the documented unapplied native validation error. */
function actionResult(data) {
	if (!record(data) || !Object.hasOwn(data, 'error')) return data;
	const failure = data.error;
	if (record(failure) && failure.applied === false && typeof failure.message === 'string' && knownCoreErrors.has(failure.code)) {
		throw new ServiceError(failure.code, false, knownCoreErrors.get(failure.code));
	}
	throw new ServiceError('invalid_backend_response');
}

/** Fixed-action client for read-only current-body attachment-reference inspection. */
export function createAttachmentReferenceClient(request) {
	requireValue(typeof request === 'function');
	const post = (action, values, signal) => request(
		'services/headless', {}, 'POST', { action, ...values }, signal, { writeOperation: false },
	);

	return Object.freeze({
		/** List one page of notes whose current bodies link to the requested attachment. */
		async listAttachmentNotes(input = {}, signal) {
			requireValue(record(input) && Object.keys(input).every(key => ['id', 'page', 'limit'].includes(key))
				&& nativeId(input.id), 'invalid_attachment_reference_input');
			let page;
			try { page = pagination({ page: input.page, limit: input.limit ?? 20 }); }
			catch { throw new ServiceError('invalid_attachment_reference_input'); }
			const data = actionResult(await post('listAttachmentNotes', { id: input.id, ...page }, signal));
			requireValue(record(data) && data.attachment_id === input.id
				&& Array.isArray(data.items) && typeof data.hasMore === 'boolean', 'invalid_backend_response');
			return {
				attachment_id: input.id,
				items: data.items.map(referenceSummary),
				hasMore: data.hasMore,
			};
		},
	});
}
