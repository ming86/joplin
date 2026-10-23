import { ServiceError, pagination, requireValue } from './errors.mjs';

/** Recognize plain JSON records returned by the fixed headless API. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate a native Joplin note or notebook identifier. */
const nativeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
/** The native API uses an empty parent id for an item at the notebook root. */
const nativeParentId = value => value === '' || nativeId(value);
/** Fixed safe messages for documented Trash action failures. */
const knownCoreErrors = new Map([
	['invalid_trash_input', 'The Trash request is invalid.'],
	['trash_item_not_found', 'The requested Trash item was not found.'],
	['trash_item_not_deleted', 'The requested item is no longer in the Trash.'],
]);

/** Validate and allowlist one note or notebook from the Trash page. */
function trashItem(data) {
	requireValue(record(data) && nativeId(data.id)
		&& (data.type === 'note' || data.type === 'notebook')
		&& typeof data.title === 'string'
		&& nativeParentId(data.parent_id)
		&& Number.isSafeInteger(data.deleted_time) && data.deleted_time > 0
		&& Number.isSafeInteger(data.updated_time) && data.updated_time >= 0
		&& (data.type !== 'note' || data.is_conflict === 0 || data.is_conflict === 1), 'invalid_backend_response');
	return {
		id: data.id,
		type: data.type,
		title: data.title,
		parent_id: data.parent_id,
		deleted_time: data.deleted_time,
		updated_time: data.updated_time,
		...(data.type === 'note' ? { is_conflict: data.is_conflict } : {}),
	};
}

/** Translate only documented native failures that certify no restore was applied. */
function actionResult(data, writing) {
	if (!record(data) || !Object.hasOwn(data, 'error')) return data;
	const failure = data.error;
	if (record(failure) && failure.applied === false && typeof failure.message === 'string' && knownCoreErrors.has(failure.code)) {
		throw new ServiceError(failure.code, false, knownCoreErrors.get(failure.code));
	}
	if (writing) throw new ServiceError('write_outcome_unknown', true);
	throw new ServiceError('invalid_backend_response');
}

/** Fixed-action client for inspecting and restoring items in the native Joplin Trash. */
export function createTrashClient(request) {
	requireValue(typeof request === 'function');
	const post = (action, values, signal, writeOperation = false) => request(
		'services/headless', {}, 'POST', { action, ...values }, signal, { writeOperation },
	);

	return Object.freeze({
		/** List one page of native deleted notes and notebooks. */
		async listTrash(input = {}, signal) {
			requireValue(record(input) && Object.keys(input).every(key => ['page', 'limit'].includes(key)), 'invalid_trash_input');
			let page;
			try { page = pagination({ page: input.page, limit: input.limit ?? 20 }); }
			catch { throw new ServiceError('invalid_trash_input'); }
			const data = actionResult(await post('listTrash', page, signal), false);
			requireValue(record(data) && Array.isArray(data.items) && typeof data.hasMore === 'boolean', 'invalid_backend_response');
			return { items: data.items.map(trashItem), hasMore: data.hasMore };
		},
		/** Restore one deleted note and return its resulting notebook parent. */
		async restoreNote(input, signal) {
			return restoreItem('restoreNote', input, signal);
		},
		/** Restore one deleted notebook and its descendant notebooks and notes. */
		async restoreNotebook(input, signal) {
			return restoreItem('restoreNotebook', input, signal);
		},
	});

	/** Restore one item through its fixed action and preserve uncertain write outcomes. */
	async function restoreItem(action, input, signal) {
		requireValue(record(input) && Object.keys(input).length === 1 && Object.hasOwn(input, 'id') && nativeId(input.id), 'invalid_trash_input');
		const id = input.id;
		const data = actionResult(await post(action, { id }, signal, true), true);
		try {
			requireValue(record(data) && data.id === id && nativeParentId(data.parent_id) && data.restored === true, 'invalid_backend_response');
			return { id: data.id, parent_id: data.parent_id, restored: true };
		} catch {
			throw new ServiceError('write_outcome_unknown', true);
		}
	}
}
