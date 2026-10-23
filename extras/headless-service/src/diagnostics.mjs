import { ServiceError } from './errors.mjs';

/** Errors already reported at an inner operation boundary. */
const loggedErrors = new WeakSet();
/** Public infrastructure failures that warrant diagnostics without request metadata. */
const diagnosticCodes = new Set(['backend_unavailable', 'backend_request_failed', 'backend_authorization_failed', 'invalid_backend_response', 'write_outcome_unknown', 'operation_failed', 'internal_error', 'note_file_download_failed']);
/** Fixed runtime messages that contain no request or response data. */
const runtimeMessages = new Set(['fetch failed', 'terminated', 'The operation was aborted.', 'This operation was aborted', 'The operation was aborted due to timeout', 'The operation was aborted']);

/** Returns safe internal names, excluding free text supplied by a caller or backend. */
function fixedName(value) {
	return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(value) ? value : undefined;
}

/** Copies only request fields supplied by the adapter, excluding query strings and bodies. */
export function requestDiagnostics(input = {}) {
	const result = {};
	if (['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(input.method)) result.method = input.method;
	if (typeof input.path === 'string' && /^\/?[A-Za-z0-9_:/-]+$/.test(input.path) && !input.path.includes('://')) result.path = input.path;
	for (const key of ['operation', 'stage']) if (fixedName(input[key])) result[key] = input[key];
	for (const key of ['elapsedMs', 'timeoutMs']) if (Number.isFinite(input[key]) && input[key] >= 0) result[key] = Math.round(input[key]);
	if (Number.isInteger(input.status) && input.status >= 100 && input.status <= 599) result.status = input.status;
	return result;
}

/** Adds safe request context while retaining the original exception identity and cause. */
export function withDiagnostics(error, diagnostics) {
	if (error instanceof Error) error.diagnostics = requestDiagnostics({ ...error.diagnostics, ...diagnostics });
	return error;
}

/** Walks native causes and aggregate connection errors without reading arbitrary fields. */
function errorChain(error) {
	const chain = [];
	const seen = new Set();
	const pending = [error];
	while (pending.length && chain.length < 8) {
		const current = pending.shift();
		if (!(current instanceof Error) || seen.has(current)) continue;
		seen.add(current);
		chain.push(current);
		pending.push(current.cause);
		if (current instanceof AggregateError) pending.push(...current.errors.filter(item => item instanceof Error).slice(0, 8));
	}
	return chain;
}

/** Extracts source locations only; stack headlines can contain note text or signed URLs. */
function stackFrames(error) {
	if (typeof error.stack !== 'string') return [];
	return error.stack.split('\n').slice(1).flatMap(line => {
		if (!/^\s+at /.test(line)) return [];
		const match = line.match(/(?:\(|\s)((?:file:\/\/\/|node:|\/)[^\s()]+:\d+:\d+)\)?$/);
		if (!match) return [];
		const location = match[1];
		// A file URL may carry query parameters; omit it rather than exposing those values.
		if (/[?#@]/.test(location)) return [];
		return [location];
	}).slice(0, 8);
}

/** Serializes useful runtime fields without arbitrary messages or response excerpts. */
function diagnosticError(error) {
	const result = { name: fixedName(error.name) ?? 'Error' };
	if (fixedName(error.code)) result.code = error.code;
	if (typeof error.errno === 'number' && Number.isFinite(error.errno)) result.errno = error.errno;
	if (fixedName(error.syscall)) result.syscall = error.syscall;
	if (error instanceof SyntaxError) result.message = 'Invalid JSON response';
	else if (error instanceof ServiceError) result.message = fixedName(error.code) ?? 'service_error';
	else if (runtimeMessages.has(error.message)) result.message = error.message;
	const frames = stackFrames(error);
	if (frames.length) result.stack = frames;
	return result;
}

/** Reports unexpected failures once to stderr, leaving expected public failures quiet. */
export function logOperationError(error, { tool, operation } = {}) {
	const chain = errorChain(error);
	if (chain.some(item => loggedErrors.has(item))) return false;
	if (error instanceof ServiceError && error.code === 'request_cancelled') return false;
	const requestError = chain.find(item => item.diagnostics);
	const diagnostics = requestDiagnostics(requestError?.diagnostics);
	if (error instanceof ServiceError) {
		if (['not_found', 'validation_error'].includes(error.code) && (!diagnostics.status || [400, 404].includes(diagnostics.status))) return false;
		const unexpected = chain.some(item => diagnosticCodes.has(item.code) || !(item instanceof ServiceError)) || diagnostics.status >= 500;
		const expected = /^(invalid_|unsupported_|empty_)/.test(error.code) || /(_conflict|_read_only|_unavailable|_not_found)$/.test(error.code) || error.code === 'not_found' || error.code === 'validation_error';
		if (expected && !unexpected) return false;
		if (!unexpected && !Object.keys(diagnostics).length) return false;
	}
	const record = { event: 'operation_error' };
	if (fixedName(tool)) record.tool = tool;
	if (fixedName(operation)) record.operation = operation;
	Object.assign(record, diagnostics);
	if (chain.length) record.errors = chain.map(diagnosticError);
	else record.errors = [{ name: 'Error', message: 'Non-error exception' }];
	console.error(JSON.stringify(record));
	for (const item of chain) loggedErrors.add(item);
	return true;
}
