import { ServiceError, pagination, requireValue } from './errors.mjs';

/** Return whether a value is a plain input record. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate the Joplin resource identifier before an account-bound operation. */
const attachmentId = value => {
	requireValue(typeof value === 'string' && /^[a-f0-9]{32}$/.test(value), 'invalid_attachment_reference_input');
	return value;
};

/** Create an account-bound adapter for read-only current-body attachment references. */
export function createAttachmentReferenceService({ backend, permit, accountId }) {
	requireValue(typeof backend === 'function' && typeof permit === 'function'
		&& typeof accountId === 'string' && accountId.length > 0);
	/** Resolve the lazily created backend once for each service operation. */
	const core = () => {
		const value = backend();
		requireValue(value && typeof value === 'object');
		return value;
	};

	return Object.freeze({
		/** List one account-bound page of current note bodies that link to an attachment. */
		async listAttachmentNotes(input = {}, signal) {
			permit('read');
			requireValue(record(input) && Object.keys(input).every(key => ['id', 'page', 'limit'].includes(key)), 'invalid_attachment_reference_input');
			const id = attachmentId(input.id);
			let page;
			try { page = pagination({ page: input.page, limit: input.limit ?? 20 }); }
			catch { throw new ServiceError('invalid_attachment_reference_input'); }
			return { accountId, ...await core().listAttachmentNotes({ id, ...page }, signal) };
		},
	});
}
