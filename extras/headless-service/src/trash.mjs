import { ServiceError, pagination, requireValue } from './errors.mjs';

/** Recognize plain input records. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate a native note or notebook identifier before selecting an item to restore. */
const trashId = value => {
	requireValue(typeof value === 'string' && /^[a-f0-9]{32}$/.test(value), 'invalid_trash_input');
	return value;
};

/** Create an account-bound service for listing and restoring native Trash items. */
export function createTrashService({ backend, permit, accountId }) {
	requireValue(typeof backend === 'function' && typeof permit === 'function'
		&& typeof accountId === 'string' && accountId.length > 0);
	/** Resolve the lazily created account backend for an operation. */
	const core = () => {
		const value = backend();
		requireValue(value && typeof value === 'object');
		return value;
	};

	return Object.freeze({
		/** List one page of deleted notes and notebooks after checking read permission. */
		async listTrash(input = {}, signal) {
			permit('read');
			requireValue(record(input) && Object.keys(input).every(key => ['page', 'limit'].includes(key)), 'invalid_trash_input');
			let page;
			try { page = pagination({ page: input.page, limit: input.limit ?? 20 }); }
			catch { throw new ServiceError('invalid_trash_input'); }
			return { accountId, ...await core().listTrash(page, signal) };
		},
		/** Restore one deleted note after checking write permission. */
		async restoreNote(input, signal) {
			permit('write');
			requireValue(record(input) && Object.keys(input).length === 1 && Object.hasOwn(input, 'id'), 'invalid_trash_input');
			const id = trashId(input.id);
			return { accountId, ...await core().restoreNote({ id }, signal) };
		},
		/** Restore one notebook subtree after checking write permission. */
		async restoreNotebook(input, signal) {
			permit('write');
			requireValue(record(input) && Object.keys(input).length === 1 && Object.hasOwn(input, 'id'), 'invalid_trash_input');
			const id = trashId(input.id);
			return { accountId, ...await core().restoreNotebook({ id }, signal) };
		},
	});
}
