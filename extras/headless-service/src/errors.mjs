// Discard upstream errors, URLs, tokens and arbitrary payloads; only recognized validation text is retained.
export class ServiceError extends Error {
	/**
	 * @param {string} code Stable machine-readable service error code.
	 * @param {boolean} outcomeUnknown Whether a write may have committed.
	 * @param {string} message Safe public message, defaulting to the code.
	 */
	constructor(code, outcomeUnknown = false, message = code) {
		super(message);
		this.name = 'ServiceError';
		this.code = code;
		this.outcomeUnknown = outcomeUnknown;
	}
}

export function requireValue(condition, code = 'invalid_configuration') {
	if (!condition) throw new ServiceError(code);
}

export function identifier(value) {
	requireValue(typeof value === 'string' && /^[a-f0-9]{32}$/.test(value), 'invalid_note_or_notebook_id');
	return value;
}

export function pagination({ page = 1, limit = 50 } = {}) {
	requireValue(Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'invalid_pagination');
	return { page, limit };
}
