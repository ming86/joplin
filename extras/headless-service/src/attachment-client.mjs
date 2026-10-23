import { ServiceError, requireValue, identifier } from './errors.mjs';
import { requestDiagnostics, withDiagnostics } from './diagnostics.mjs';
import { validateHeaderValue } from 'node:http';

/** Metadata exposed for an attachment, including the fields needed for eligibility checks. */
const attachmentFields = [
	'id', 'title', 'mime', 'file_extension', 'size', 'created_time', 'updated_time',
	'encryption_applied', 'encryption_blob_encrypted', 'is_locked',
].join(',');

/** Validate the endpoint shape; the account registry already applies the configured HTTP/TLS policy. */
function apiEndpoint(value) {
	let url;
	try { url = new URL(value); } catch { throw new ServiceError('invalid_configuration'); }
	requireValue(url.protocol === 'https:' || url.protocol === 'http:');
	requireValue(!url.username && !url.password && !url.search && !url.hash);
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
	return url.href;
}

/** Keep a native resource filename to one path component before exposing it to MCP. */
function safeFilename(value) {
	if (typeof value !== 'string' || !value) return '';
	return value.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

/** Return an MCP-friendly filename without exposing a resource's stored path. */
function displayFilename(resource) {
	const title = safeFilename(resource.title) || resource.id;
	const extension = resource.file_extension;
	if (extension && !title.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) return `${title}.${extension}`;
	const stored = safeFilename(resource.filename);
	return title === resource.id && stored ? stored : title;
}

/** Validate and allowlist fields returned by the private Data API. */
function attachmentResult(data) {
	requireValue(data && typeof data === 'object' && !Array.isArray(data)
		&& typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id), 'invalid_backend_response');
	const textFields = ['title', 'mime', 'file_extension'];
	for (const key of textFields) {
		if (!Object.hasOwn(data, key)) continue;
		requireValue(data[key] === null || typeof data[key] === 'string', 'invalid_backend_response');
	}
	for (const key of ['size', 'created_time', 'updated_time']) {
		if (!Object.hasOwn(data, key)) continue;
		requireValue(Number.isSafeInteger(data[key]) && data[key] >= 0, 'invalid_backend_response');
	}
	for (const key of ['encryption_applied', 'encryption_blob_encrypted', 'is_locked']) {
		if (!Object.hasOwn(data, key)) continue;
		requireValue(data[key] === 0 || data[key] === 1, 'invalid_backend_response');
	}

	const result = Object.fromEntries([
		'id', 'title', 'mime', 'file_extension', 'size', 'created_time', 'updated_time',
		'encryption_applied', 'encryption_blob_encrypted', 'is_locked',
	].filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
	result.filename = displayFilename(data);
	return result;
}

/** Validate a pathless filename supplied by a remote caller. */
function requireFilename(value) {
	requireValue(typeof value === 'string' && value.length > 0
		&& !/[\\/\u0000-\u001f\u007f]/.test(value) && value !== '.' && value !== '..', 'invalid_attachment_input');
	return value;
}

/** Decode only canonical padded base64, avoiding Buffer's permissive truncation behavior. */
function decodeBase64(value) {
	requireValue(typeof value === 'string', 'invalid_attachment_input');
	const bytes = Buffer.from(value, 'base64');
	requireValue(bytes.toString('base64') === value, 'invalid_attachment_input');
	return bytes;
}

/** Validate caller-provided attachment changes without accepting arbitrary Data API properties. */
function attachmentInput(input, creating) {
	requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_attachment_input');
	const allowed = creating
		? ['filename', 'contentBase64', 'title', 'mime']
		: ['title', 'filename', 'mime', 'contentBase64'];
	requireValue(Object.keys(input).every(key => allowed.includes(key)), 'unsupported_attachment_property');
	if (creating) requireFilename(input.filename);
	else if (Object.hasOwn(input, 'filename')) requireFilename(input.filename);
	if (Object.hasOwn(input, 'contentBase64')) decodeBase64(input.contentBase64);
	if (creating) requireValue(Object.hasOwn(input, 'contentBase64'), 'invalid_attachment_input');
	else requireValue(Object.keys(input).length > 0, 'empty_attachment_update');
	if (Object.hasOwn(input, 'title')) requireValue(typeof input.title === 'string', 'invalid_attachment_input');
	if (Object.hasOwn(input, 'mime')) {
		requireValue(typeof input.mime === 'string', 'invalid_attachment_input');
		// Joplin returns mime as the Content-Type header for resource downloads.
		// Enforce Node's actual header-value boundary while leaving media-type policy to Joplin.
		try { validateHeaderValue('Content-Type', input.mime); }
		catch { throw new ServiceError('invalid_attachment_input'); }
	}
	return input;
}

/** Validate the expected paginated collection shape. */
function pageResult(data) {
	requireValue(data && typeof data === 'object' && Array.isArray(data.items) && typeof data.has_more === 'boolean', 'invalid_backend_response');
	return { items: data.items.map(attachmentResult), hasMore: data.has_more };
}

/** Error codes and fixed safe messages returned by native attachment actions. */
const knownCoreErrors = new Map([
	['invalid_attachment_input', 'The attachment request is invalid.'],
	['unsupported_attachment_property', 'The attachment update contains an unsupported property.'],
	['empty_attachment_update', 'The attachment update does not contain any changes.'],
	['attachment_unavailable', 'The attachment is not available.'],
	['validation_error', 'The request did not pass validation.'],
]);

/** Unwrap native action errors only when the core confirms no write was applied. */
function actionResult(data) {
	if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'error')) return data;
	const failure = data.error;
	if (failure && typeof failure === 'object' && !Array.isArray(failure)
		&& failure.applied === false && knownCoreErrors.has(failure.code)) {
		throw new ServiceError(failure.code, false, knownCoreErrors.get(failure.code));
	}
	throw new ServiceError('write_outcome_unknown', true);
}

/** Map a failed private Data API response without retaining upstream payloads. */
function responseError(status) {
	if (status === 404) return new ServiceError('not_found');
	if (status === 401 || status === 403) return new ServiceError('backend_authorization_failed');
	return new ServiceError('backend_request_failed');
}

/**
 * Create a narrow resource client over the private Data API and fixed headless attachment actions.
 * JSON metadata and attachment writes use the injected Joplin request helper. Binary file reads use fetch
 * directly because they return raw bytes rather than JSON.
 */
export function createAttachmentClient({ request, baseUrl, token, timeoutMs = 10000 }) {
	requireValue(typeof request === 'function', 'invalid_configuration');
	const base = apiEndpoint(baseUrl);
	requireValue(typeof token === 'string' && token.length > 0);
	requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);

	function urlFor(route, params = {}) {
		const url = new URL(route, base);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
		url.searchParams.set('token', token);
		return url;
	}

	function requestSignal(signal) {
		if (signal?.aborted) throw new ServiceError('request_cancelled');
		const timeout = AbortSignal.timeout(timeoutMs);
		return signal ? AbortSignal.any([signal, timeout]) : timeout;
	}

	/** Send one fixed native write action and preserve uncertainty after any unusable result. */
	async function writeAction(action, values, signal, expectedId) {
		const startedAt = Date.now();
		const response = await request('services/headless', {}, 'POST', { action, ...values }, signal, { writeOperation: true });
		let data;
		try { data = actionResult(response); }
		catch (error) {
			if (!(error instanceof ServiceError)) throw error;
			throw withDiagnostics(error, requestDiagnostics({
				method: 'POST', path: 'services/headless', operation: action,
				elapsedMs: Date.now() - startedAt, stage: 'validation',
			}));
		}
		try {
			const result = attachmentResult(data);
			requireValue(attachmentFields.split(',').every(key => Object.hasOwn(result, key)), 'invalid_backend_response');
			if (expectedId !== undefined) requireValue(result.id === expectedId, 'invalid_backend_response');
			return result;
		} catch (error) {
			throw new ServiceError('write_outcome_unknown', true, undefined, {
				cause: error,
				diagnostics: requestDiagnostics({
					method: 'POST', path: 'services/headless', operation: action,
					elapsedMs: Date.now() - startedAt, stage: 'validation',
				}),
			});
		}
	}

	/** Read and validate one resource's metadata without exposing a local path or file URL. */
	async function getAttachment(resourceId, signal) {
		const id = identifier(resourceId);
		const startedAt = Date.now();
		const data = await request(`resources/${id}`, { fields: attachmentFields }, 'GET', undefined, signal);
		try {
			const result = attachmentResult(data);
			requireValue(result.id === id, 'invalid_backend_response');
			return result;
		} catch (error) {
			throw withDiagnostics(error, requestDiagnostics({
				method: 'GET', path: 'resources/id', operation: 'getAttachment',
				elapsedMs: Date.now() - startedAt, stage: 'validation',
			}));
		}
	}

	/** Read bytes only after the resource's encryption and lock state has been checked. */
	async function readBytes(metadata, signal) {
		if (metadata.encryption_applied !== 0 || metadata.encryption_blob_encrypted !== 0 || metadata.is_locked !== 0) {
			throw new ServiceError('attachment_unavailable');
		}
		const combined = requestSignal(signal);
		const startedAt = Date.now();
		let response;
		try {
			response = await fetch(urlFor(`resources/${metadata.id}/file`), { signal: combined, redirect: 'error' });
		} catch (error) {
			throw new ServiceError(signal?.aborted ? 'request_cancelled' : 'backend_unavailable', false, undefined, {
				cause: error,
				diagnostics: requestDiagnostics({
					method: 'GET', path: 'resources/id/file', operation: 'readAttachment',
					elapsedMs: Date.now() - startedAt, stage: 'request', timeoutMs,
				}),
			});
		}
		if (!response.ok) {
			let cancelError;
			try { await response.body?.cancel(); } catch (error) { cancelError = error; }
			const diagnostics = requestDiagnostics({
				method: 'GET', path: 'resources/id/file', operation: 'readAttachment',
				elapsedMs: Date.now() - startedAt, status: response.status,
				stage: cancelError ? 'response_cleanup' : 'response', timeoutMs,
			});
			const failure = response.status >= 500 ? new ServiceError('attachment_file_unavailable') : responseError(response.status);
			if (cancelError) {
				throw new ServiceError(failure.code, failure.outcomeUnknown, failure.message, { cause: cancelError, diagnostics });
			}
			throw withDiagnostics(failure, diagnostics);
		}
		try { return Buffer.from(await response.arrayBuffer()); }
		catch (error) {
			const code = signal?.aborted ? 'request_cancelled' : combined.aborted ? 'backend_unavailable' : 'attachment_file_unavailable';
			throw new ServiceError(code, false, undefined, {
				cause: error,
				diagnostics: requestDiagnostics({
					method: 'GET', path: 'resources/id/file', operation: 'readAttachment',
					elapsedMs: Date.now() - startedAt, status: response.status, stage: 'body', timeoutMs,
				}),
			});
		}
	}

	return Object.freeze({
		/** List all linked attachment metadata, following every page returned by the core API. */
		async listNoteAttachments(noteId, signal) {
			const note = identifier(noteId);
			const items = [];
			for (let page = 1; ; page++) {
				const startedAt = Date.now();
				const data = await request(`notes/${note}/resources`, {
					fields: attachmentFields,
					limit: 100,
					page,
				}, 'GET', undefined, signal);
				let result;
				try { result = pageResult(data); }
				catch (error) {
					throw withDiagnostics(error, requestDiagnostics({
						method: 'GET', path: 'notes/id/resources', operation: 'listNoteAttachments',
						elapsedMs: Date.now() - startedAt, stage: 'validation',
					}));
				}
				items.push(...result.items);
				if (!result.hasMore) return items;
			}
		},

		/** Read one resource's metadata without exposing its local storage path or file URL. */
		async getAttachment(resourceId, signal) {
			return getAttachment(resourceId, signal);
		},

		/** Fetch exact resource bytes and return them as canonical base64 for MCP embedded-resource output. */
		async readAttachment(resourceId, signal) {
			const id = identifier(resourceId);
			const metadata = await getAttachment(id, signal);
			const bytes = await readBytes(metadata, signal);
			return {
				...metadata,
				filename: metadata.filename || displayFilename(metadata),
				size: bytes.length,
				contentBase64: bytes.toString('base64'),
			};
		},

		/** Upload bytes as a new Joplin resource; note linking remains a separate note-body update. */
		async createAttachment(input, signal) {
			attachmentInput(input, true);
			const filename = requireFilename(input.filename);
			return writeAction('createAttachment', {
				filename,
				contentBase64: input.contentBase64,
				...(input.title === undefined ? {} : { title: input.title }),
				...(input.mime === undefined ? {} : { mime: input.mime }),
			}, signal);
		},

		/** Rename, change MIME, or replace bytes through one native attachment action. */
		async updateAttachment(resourceId, input, signal) {
			const id = identifier(resourceId);
			attachmentInput(input, false);
			return writeAction('updateAttachment', {
				id,
				...(input.filename === undefined ? {} : { filename: input.filename }),
				...(input.contentBase64 === undefined ? {} : { contentBase64: input.contentBase64 }),
				...(input.title === undefined ? {} : { title: input.title }),
				...(input.mime === undefined ? {} : { mime: input.mime }),
			}, signal, id);
		},
	});
}
