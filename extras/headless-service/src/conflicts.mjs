import { ServiceError, pagination, requireValue } from './errors.mjs';

/** Recognize plain input records. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate a native Joplin conflict identifier. */
const conflictId = value => {
	requireValue(typeof value === 'string' && /^[a-f0-9]{32}$/.test(value), 'invalid_conflict_input');
	return value;
};

/** Create an account-bound adapter for read-only sync conflict inspection. */
export function createConflictService({ backend, permit, accountId }) {
	requireValue(typeof backend === 'function' && typeof permit === 'function'
		&& typeof accountId === 'string' && accountId.length > 0);
	/** Resolve the lazily created backend once for each service operation. */
	const core = () => {
		const value = backend();
		requireValue(value && typeof value === 'object');
		return value;
	};

	return Object.freeze({
		/** List one account-bound page of device-local sync conflicts. */
		async listConflicts(input = {}, signal) {
			permit('read');
			requireValue(record(input) && Object.keys(input).every(key => ['page', 'limit'].includes(key)), 'invalid_conflict_input');
			let page;
			try { page = pagination({ page: input.page, limit: input.limit }); }
			catch { throw new ServiceError('invalid_conflict_input'); }
			const result = await core().listConflicts(page, signal);
			return { accountId, ...result };
		},
		/** Read the conflict copy and original note as they currently exist on this device. */
		async readConflict(input, signal) {
			permit('read');
			requireValue(record(input) && Object.keys(input).length === 1 && Object.hasOwn(input, 'id'), 'invalid_conflict_input');
			const id = conflictId(input.id);
			return { accountId, ...await core().readConflict({ id }, signal) };
		},
	});
}
