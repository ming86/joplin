// Deliberately do not retain upstream errors, URLs, tokens or response payloads.
export class ServiceError extends Error {
	constructor(code, outcomeUnknown = false) {
		super(code);
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
