/** Public service failure with an optional private cause and request diagnostics. */
export class ServiceError extends Error {
	/**
	 * @param {string} code Stable machine-readable service error code.
	 * @param {boolean} outcomeUnknown Whether a write may have committed.
	 * @param {string} message Safe public message, defaulting to the code.
	 * @param {{cause?: unknown, diagnostics?: object}} options Internal failure context, never returned to callers.
	 */
	constructor(code, outcomeUnknown = false, message = code, { cause, diagnostics } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'ServiceError';
		/** Stable public error code. */
		this.code = code;
		/** Whether a write may already have committed. */
		this.outcomeUnknown = outcomeUnknown;
		/** Private request metadata; logging uses an explicit field allowlist. */
		if (diagnostics) this.diagnostics = diagnostics;
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
