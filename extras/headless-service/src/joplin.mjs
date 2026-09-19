import { ServiceError, requireValue, identifier, pagination } from './errors.mjs';

const noteFields = 'id,parent_id,title,body,updated_time,markup_language,encryption_applied,deleted_time,is_locked';

export function endpoint(value, allowInsecureHttp = false) {
	let url;
	try { url = new URL(value); } catch { throw new ServiceError('invalid_configuration'); }
	const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
	requireValue(url.protocol === 'https:' || (url.protocol === 'http:' && (loopback || allowInsecureHttp === true)));
	requireValue(!url.username && !url.password && !url.search && !url.hash);
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
	return url.href;
}

function noteResult(data) {
	requireValue(data && typeof data === 'object' && typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id), 'invalid_backend_response');
	for (const key of noteFields.split(',')) {
		if (!Object.hasOwn(data, key)) continue;
		const isText = ['id', 'parent_id', 'title', 'body'].includes(key);
		requireValue(isText ? typeof data[key] === 'string' : typeof data[key] === 'number' && Number.isFinite(data[key]), 'invalid_backend_response');
	}
	// Allowlist returned properties; a future upstream property cannot leak through by accident.
	return Object.fromEntries(noteFields.split(',').filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
}

function pageResult(data, map) {
	requireValue(data && Array.isArray(data.items) && typeof data.has_more === 'boolean', 'invalid_backend_response');
	return { items: data.items.map(map), hasMore: data.has_more };
}

function noteInput(input, creating) {
	requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_note_input');
	const allowed = creating ? ['title', 'body', 'parentId'] : ['title', 'body'];
	requireValue(Object.keys(input).every(key => allowed.includes(key)), 'unsupported_note_property');
	if (creating) identifier(input.parentId);
	for (const key of ['title', 'body']) {
		if (creating || Object.hasOwn(input, key)) requireValue(typeof input[key] === 'string', 'invalid_note_input');
	}
	requireValue(creating || Object.keys(input).length > 0, 'empty_note_update');
	const result = {};
	if ('title' in input) result.title = input.title;
	if ('body' in input) result.body = input.body;
	if (creating) { result.parent_id = input.parentId; result.markup_language = 1; }
	return result;
}

// Private Data API adapter. Not an HTTP gateway; callers cannot supply arbitrary routes.
export function createJoplinClient(config) {
	const baseUrl = endpoint(config.baseUrl, config.allowInsecureHttp);
	const token = config.token;
	requireValue(typeof token === 'string' && token.length > 0);
	const timeoutMs = config.timeoutMs ?? 10000;
	const maxResponseBytes = config.maxResponseBytes ?? 8 * 1024 * 1024;
	requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);
	requireValue(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= 128 * 1024 * 1024);

	async function request(route, params = {}, method = 'GET', body, signal) {
		const url = new URL(route, baseUrl);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
		url.searchParams.set('token', token);
		const writing = method !== 'GET';
		if (signal?.aborted) throw new ServiceError('request_cancelled');
		const timeout = AbortSignal.timeout(timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			const response = await fetch(url, {
				method, signal: combined, redirect: 'error',
				headers: body ? { 'Content-Type': 'application/json' } : {},
				body: body ? JSON.stringify(body) : undefined,
			});
			if (!response.ok) {
				await response.body?.cancel();
				if (writing && response.status >= 500) throw new ServiceError('write_outcome_unknown', true);
				throw new ServiceError(response.status === 404 ? 'not_found' : response.status === 401 || response.status === 403 ? 'backend_authorization_failed' : 'backend_request_failed');
			}
			const parts = [];
			let size = 0;
			if (response.body) {
				const reader = response.body.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						size += value.byteLength;
						if (size > maxResponseBytes) {
							await reader.cancel();
							throw new ServiceError(writing ? 'write_outcome_unknown' : 'backend_response_too_large', writing);
						}
						parts.push(Buffer.from(value));
					}
				} finally { reader.releaseLock(); }
			}
			return JSON.parse(Buffer.concat(parts).toString('utf8'));
		} catch (error) {
			if (error instanceof ServiceError) throw error;
			// POST/PUT may have committed before transport/response parsing failed. Never retry automatically.
			throw new ServiceError(writing ? 'write_outcome_unknown' : signal?.aborted ? 'request_cancelled' : 'backend_unavailable', writing);
		}
	}

	return Object.freeze({
		async listNotebooks(options, signal) {
			return pageResult(await request('folders', { ...pagination(options), fields: 'id,title,parent_id' }, 'GET', undefined, signal), data => {
				requireValue(data && /^[a-f0-9]{32}$/.test(data.id) && typeof data.title === 'string', 'invalid_backend_response');
				return { id: data.id, title: data.title, parent_id: data.parent_id ?? '' };
			});
		},
		async listNotes(options, signal) {
			return pageResult(await request('notes', { ...pagination(options), order_by: 'id', order_dir: 'ASC', fields: noteFields }, 'GET', undefined, signal), noteResult);
		},
		async listIndexNotes(options, signal) {
			// Metadata-only enumeration avoids accumulating many large bodies in one response.
			return pageResult(await request('notes', { ...pagination(options), order_by: 'id', order_dir: 'ASC', fields: 'id' }, 'GET', undefined, signal), noteResult);
		},
		async getNote(id, signal) {
			return noteResult(await request(`notes/${identifier(id)}`, { fields: noteFields }, 'GET', undefined, signal));
		},
		async createNote(input, signal) {
			const data = await request('notes', {}, 'POST', noteInput(input, true), signal);
			try { return noteResult(data); } catch { throw new ServiceError('write_outcome_unknown', true); }
		},
		async updateNote(id, input, signal) {
			const data = await request(`notes/${identifier(id)}`, {}, 'PUT', noteInput(input, false), signal);
			try { return noteResult(data); } catch { throw new ServiceError('write_outcome_unknown', true); }
		},
		async search(query, options, signal) {
			requireValue(typeof query === 'string' && query.trim().length > 0 && query.length <= 10000, 'invalid_query');
			return pageResult(await request('search', { query, ...pagination(options), type: 'note', fields: noteFields }, 'GET', undefined, signal), noteResult);
		},
		async changes(cursor, signal) {
			requireValue(cursor === undefined || (typeof cursor === 'string' && /^\d+$/.test(cursor)), 'invalid_cursor');
			const data = await request('events', cursor === undefined ? {} : { cursor }, 'GET', undefined, signal);
			requireValue(data && typeof data.cursor === 'string' && /^\d+$/.test(data.cursor), 'invalid_backend_response');
			const result = pageResult(data, item => {
				requireValue(item && Number.isSafeInteger(item.id) && typeof item.item_id === 'string' && Number.isSafeInteger(item.type), 'invalid_backend_response');
				return { id: item.id, itemId: item.item_id, itemType: item.item_type, type: item.type, createdTime: item.created_time };
			});
			return { ...result, cursor: data.cursor };
		},
	});
}
