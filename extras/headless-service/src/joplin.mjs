import { ServiceError, requireValue, identifier, pagination } from './errors.mjs';
import { requestDiagnostics, withDiagnostics } from './diagnostics.mjs';
import { createMaintenanceClient } from './maintenance-client.mjs';
import { createRevisionClient } from './revision-client.mjs';
import { createConflictClient } from './conflict-client.mjs';
import { createAttachmentClient } from './attachment-client.mjs';
import { createTrashClient } from './trash-client.mjs';
import { createAttachmentReferenceClient } from './attachment-reference-client.mjs';

/** Fields used by note reads and metadata scans. */
const noteFields = 'id,parent_id,title,body,created_time,updated_time,is_todo,todo_due,todo_completed,source,source_application,source_url,markup_language,encryption_applied,deleted_time,is_locked';
/** Status counters exposed by the fixed headless status contract. */
const statusCounterFields = [
	'itemConflict', 'noteConflict', 'resourceConflict',
	'createRemote', 'updateRemote', 'deleteRemote',
	'createLocal', 'updateLocal', 'deleteLocal',
	'fetchingTotal', 'fetchingProcessed',
];

export function endpoint(value, allowInsecureHttp = false) {
	let url;
	try { url = new URL(value); } catch { throw new ServiceError('invalid_configuration'); }
	const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
	requireValue(url.protocol === 'https:' || (url.protocol === 'http:' && (loopback || allowInsecureHttp === true)));
	requireValue(!url.username && !url.password && !url.search && !url.hash);
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
	return url.href;
}

/** Validates note fields and returns only the fields this adapter exposes. */
function noteResult(data) {
	requireValue(data && typeof data === 'object' && typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id), 'invalid_backend_response');
	for (const key of noteFields.split(',')) {
		if (!Object.hasOwn(data, key)) continue;
		const isText = ['id', 'parent_id', 'title', 'body', 'source', 'source_application', 'source_url'].includes(key);
		const valid = isText ? typeof data[key] === 'string'
			: key === 'todo_due' ? Number.isInteger(data[key])
				: typeof data[key] === 'number' && Number.isFinite(data[key]);
		requireValue(valid, 'invalid_backend_response');
	}
	// Allowlist returned properties; a future upstream property cannot leak through by accident.
	return Object.fromEntries(noteFields.split(',').filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
}

function pageResult(data, map) {
	requireValue(data && Array.isArray(data.items) && typeof data.has_more === 'boolean', 'invalid_backend_response');
	return { items: data.items.map(map), hasMore: data.has_more };
}

/** Validate and allowlist the headless service's live sync/decryption summary. */
function headlessStatusResult(data) {
	const timestamp = value => Number.isSafeInteger(value) && value >= 0;
	const nullableTimestamp = value => value === null || timestamp(value);
	const count = value => Number.isSafeInteger(value) && value >= 0;
	const reportStates = ['idle', 'in_progress', null];
	requireValue(data && typeof data === 'object' && (typeof data.accountEmail === 'string' || data.accountEmail === null)
		&& timestamp(data.observedAt) && timestamp(data.serviceStartedAt)
		&& data.sync && typeof data.sync === 'object' && typeof data.sync.running === 'boolean' && typeof data.sync.pending === 'boolean'
		&& data.decryption && typeof data.decryption === 'object'
		&& (data.decryption.state === null || data.decryption.state === 'idle' || data.decryption.state === 'started')
		&& typeof data.decryption.missingMasterKey === 'boolean' && count(data.decryption.disabledItemCount), 'invalid_backend_response');

	let report = null;
	if (data.sync.report !== null) {
		const input = data.sync.report;
		requireValue(input && typeof input === 'object' && reportStates.includes(input.state)
			&& nullableTimestamp(input.startTime) && nullableTimestamp(input.completedTime)
			&& input.counters && typeof input.counters === 'object' && !Array.isArray(input.counters)
			&& count(input.errorCount), 'invalid_backend_response');
		const counters = {};
		for (const key of statusCounterFields) {
			if (!Object.hasOwn(input.counters, key)) continue;
			requireValue(count(input.counters[key]), 'invalid_backend_response');
			counters[key] = input.counters[key];
		}
		report = {
			state: input.state,
			startTime: input.startTime,
			completedTime: input.completedTime,
			counters,
			errorCount: input.errorCount,
		};
	}

	let batch = null;
	if (data.decryption.batch !== null) {
		const input = data.decryption.batch;
		requireValue(input && typeof input === 'object' && count(input.itemIndex) && count(input.itemCount), 'invalid_backend_response');
		batch = { itemIndex: input.itemIndex, itemCount: input.itemCount };
	}
	return {
		accountEmail: data.accountEmail,
		observedAt: data.observedAt,
		serviceStartedAt: data.serviceStartedAt,
		sync: {
			running: data.sync.running,
			pending: data.sync.pending,
			report: report,
		},
		decryption: {
			state: data.decryption.state,
			batch,
			missingMasterKey: data.decryption.missingMasterKey,
			disabledItemCount: data.decryption.disabledItemCount,
		},
	};
}

/** Maps the supported note patch fields to the private Data API request shape. */
function noteInput(input, creating) {
	requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_note_input');
	const allowed = ['title', 'body', 'parentId', 'is_todo', 'todo_due', 'todo_completed', 'source_url'];
	requireValue(Object.keys(input).every(key => allowed.includes(key)), 'unsupported_note_property');
	if (creating || Object.hasOwn(input, 'parentId')) identifier(input.parentId);
	for (const key of ['title', 'body']) {
		if (creating || Object.hasOwn(input, key)) requireValue(typeof input[key] === 'string', 'invalid_note_input');
	}
	requireValue(creating || Object.keys(input).length > 0, 'empty_note_update');
	if (Object.hasOwn(input, 'is_todo')) requireValue(input.is_todo === 0 || input.is_todo === 1, 'invalid_note_input');
	if (Object.hasOwn(input, 'todo_due')) requireValue(Number.isInteger(input.todo_due), 'invalid_note_input');
	if (Object.hasOwn(input, 'todo_completed')) requireValue(Number.isSafeInteger(input.todo_completed) && input.todo_completed >= 0, 'invalid_note_input');
	if (Object.hasOwn(input, 'source_url')) requireValue(typeof input.source_url === 'string', 'invalid_note_input');
	const result = {};
	if ('title' in input) result.title = input.title;
	if ('body' in input) result.body = input.body;
	if ('parentId' in input) result.parent_id = input.parentId;
	if ('is_todo' in input) result.is_todo = input.is_todo;
	if ('todo_due' in input) result.todo_due = input.todo_due;
	if ('todo_completed' in input) result.todo_completed = input.todo_completed;
	if ('source_url' in input) result.source_url = input.source_url;
	if (creating) { result.is_todo ??= 0; result.markup_language = 1; }
	return result;
}

// Private Data API adapter. Not an HTTP gateway; callers cannot supply arbitrary routes.
export function createJoplinClient(config) {
	const baseUrl = endpoint(config.baseUrl, config.allowInsecureHttp);
	const token = config.token;
	requireValue(typeof token === 'string' && token.length > 0);
	const timeoutMs = config.timeoutMs ?? 10000;
	requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);

	/** Sends one authenticated Data API request and preserves uncertain write outcomes. */
	async function request(route, params = {}, method = 'GET', body, signal, { allowEmptyPost = false, writeOperation = method !== 'GET', validateResult } = {}) {
		const started = performance.now();
		let stage = 'fetch';
		let status;
		/** Captures adapter-owned context without query parameters, credentials, or request bodies. */
		const diagnostics = () => requestDiagnostics({ method, path: route, operation: route === 'services/headless' ? body?.action : undefined, elapsedMs: performance.now() - started, status, stage, timeoutMs });
		const url = new URL(route, baseUrl);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
		url.searchParams.set('token', token);
		const writing = writeOperation;
		if (signal?.aborted) throw new ServiceError('request_cancelled', false, 'request_cancelled', { cause: signal.reason, diagnostics: diagnostics() });
		const timeout = AbortSignal.timeout(timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			const response = await fetch(url, {
				method, signal: combined, redirect: 'error',
				headers: body ? { 'Content-Type': 'application/json' } : {},
				body: body ? JSON.stringify(body) : undefined,
			});
			status = response.status;
			if (!response.ok) {
				let cause;
				if (response.status === 400) {
					let payload;
					stage = 'read_error_response';
					try { payload = await response.json(); } catch (error) { cause = error; }
					if (payload && typeof payload === 'object' && !Array.isArray(payload)
						&& payload.code === 'validation_error' && typeof payload.error === 'string' && payload.error.length > 0) {
						throw new ServiceError('validation_error', false, payload.error);
					}
				} else {
					stage = 'cancel_error_response';
					await response.body?.cancel();
				}
				stage = 'http_response';
				if (writing && response.status >= 500) throw new ServiceError('write_outcome_unknown', true, 'write_outcome_unknown', { cause });
				const code = response.status === 404 ? 'not_found' : response.status === 401 || response.status === 403 ? 'backend_authorization_failed' : 'backend_request_failed';
				throw new ServiceError(code, false, code, { cause });
			}
			stage = 'read_response';
			const text = await response.text();
			// Joplin returns an empty 200 for DELETE and for duplicate tag associations.
			if (text.length === 0 && (method === 'DELETE' || (method === 'POST' && allowEmptyPost))) return null;
			stage = 'parse_response';
			const data = JSON.parse(text);
			if (!validateResult) return data;
			stage = 'validate_response';
			try { return validateResult(data); }
			catch (error) {
				if (!writing) throw error;
				throw new ServiceError('write_outcome_unknown', true, 'write_outcome_unknown', { cause: error });
			}
		} catch (error) {
			if (error instanceof ServiceError) throw withDiagnostics(error, diagnostics());
			// POST/PUT may have committed before transport/response parsing failed. Never retry automatically.
			const code = writing ? 'write_outcome_unknown' : signal?.aborted ? 'request_cancelled' : 'backend_unavailable';
			throw new ServiceError(code, writing, code, { cause: error, diagnostics: diagnostics() });
		}
	}

	/** Fetches every page until the backend reports that the collection has ended. */
	async function fetchAllPages(route, params, map, signal) {
		const items = [];
		for (let page = 1; ; page++) {
			const result = await request(route, { ...params, limit: 100, page }, 'GET', undefined, signal, { validateResult: data => pageResult(data, map) });
			items.push(...result.items);
			if (!result.hasMore) return items;
		}
	}

	/** Validates folder fields returned by the private Data API. */
	function notebookResult(data) {
		requireValue(data && typeof data === 'object' && typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id) && typeof data.title === 'string', 'invalid_backend_response');
		for (const key of ['parent_id', 'encryption_applied', 'deleted_time']) {
			if (!Object.hasOwn(data, key)) continue;
			const valid = key === 'parent_id' ? typeof data[key] === 'string' : typeof data[key] === 'number' && Number.isFinite(data[key]);
			requireValue(valid, 'invalid_backend_response');
		}
		return {
			id: data.id,
			title: data.title,
			parent_id: data.parent_id ?? '',
			encryption_applied: data.encryption_applied,
			deleted_time: data.deleted_time,
		};
	}

	/** Validates a tag and retains its encryption state only for internal filtering. */
	function tagResult(data) {
		requireValue(data && typeof data === 'object' && typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id) && typeof data.title === 'string', 'invalid_backend_response');
		if (Object.hasOwn(data, 'encryption_applied')) {
			requireValue(typeof data.encryption_applied === 'number' && Number.isFinite(data.encryption_applied), 'invalid_backend_response');
		}
		return { id: data.id, title: data.title, encryption_applied: data.encryption_applied };
	}

	/** Includes only folders that are visible to the decrypted account view. */
	function visibleNotebook(notebook) {
		// Only an explicit zero proves that an E2EE-backed folder is decrypted.
		return notebook.encryption_applied === 0 && !(notebook.deleted_time > 0);
	}

	return Object.freeze({
		...createMaintenanceClient(request),
		...createRevisionClient(request),
		...createConflictClient(request),
		...createTrashClient(request),
		...createAttachmentReferenceClient(request),
		...createAttachmentClient({ request, baseUrl, token, timeoutMs }),
		/** Reads the core process's in-memory synchronization and decryption summary. */
		async status(signal) {
			return request('services/headless', {}, 'POST', { action: 'status' }, signal, { writeOperation: false, validateResult: headlessStatusResult });
		},
		// Metadata-only browser enumeration. Body retrieval remains an explicit operation.
		async listNoteSummaries(options = {}, signal) {
			const { notebookId, ...page } = options;
			const route = notebookId ? `folders/${identifier(notebookId)}/notes` : 'notes';
			return request(route, { ...pagination(page), order_by: 'id', order_dir: 'ASC', fields: noteFields.split(',').filter(f => f !== 'body').join(',') }, 'GET', undefined, signal, { validateResult: data => pageResult(data, noteResult) });
		},
		async createWebPlaceholder(input, signal) {
			identifier(input.id); identifier(input.parentId);
			requireValue(/^joplin-headless-web\/v1:[a-f0-9]{64}$/.test(input.receipt), 'invalid_web_receipt');
			// POST /notes can download media. Never submit user Markdown to that route.
			const data = await request('notes', {}, 'POST', { id: input.id, parent_id: input.parentId, title: '[Pending web note]', body: '', source: input.receipt, markup_language: 1 }, signal, {
				validateResult(data) { requireValue(data?.id === input.id, 'invalid_backend_response'); return data; },
			});
			return { id: data.id };
		},
		// Reserved clipper operations, not exposed as arbitrary MCP/HTTP routes.
		/** Reads an available notebook, retaining the legacy clipper error for unsafe folders. */
		async getNotebook(id, signal) {
			const notebook = await request(`folders/${identifier(id)}`, { fields: 'id,title,parent_id,encryption_applied,deleted_time' }, 'GET', undefined, signal, {
				validateResult(data) {
					try { return notebookResult(data); } catch (cause) { throw new ServiceError('clip_notebook_unavailable', false, 'clip_notebook_unavailable', { cause }); }
				},
			});
			requireValue(notebook.id === id && visibleNotebook(notebook), 'clip_notebook_unavailable');
			return { id: notebook.id, title: notebook.title, parent_id: notebook.parent_id || null };
		},
		async getClipRecord(id, signal) {
			return request(`notes/${identifier(id)}`, { fields: 'id,parent_id,source,deleted_time,encryption_applied,is_locked', include_deleted: 1, include_conflicts: 1 }, 'GET', undefined, signal, { validateResult(data) {
				requireValue(data && data.id === id && typeof data.parent_id === 'string' && typeof data.source === 'string', 'invalid_backend_response');
				return { id: data.id, parent_id: data.parent_id, source: data.source, deleted_time: data.deleted_time, encryption_applied: data.encryption_applied, is_locked: data.is_locked };
			} });
		},
		async createClipRecord(input, signal) {
			identifier(input.id); identifier(input.parent_id);
			requireValue(typeof input.source === 'string' && /^joplin-headless-clip\/v1:[a-f0-9]{64}$/.test(input.source), 'invalid_clip_receipt');
			const data = await request('notes', {}, 'POST', { id: input.id, parent_id: input.parent_id, title: input.title, body: input.body, source: input.source, source_url: input.source_url, markup_language: 1 }, signal, {
				validateResult(data) { requireValue(data?.id === input.id, 'invalid_backend_response'); return data; },
			});
			return { id: data.id };
		},
		/** Lists one page of available notebooks, omitting encrypted and deleted folders. */
		async listNotebooks(options, signal) {
			const result = await request('folders', { ...pagination(options), fields: 'id,title,parent_id,encryption_applied,deleted_time' }, 'GET', undefined, signal, { validateResult: data => pageResult(data, notebookResult) });
			return { ...result, items: result.items.filter(visibleNotebook).map(({ id, title, parent_id }) => ({ id, title, parent_id })) };
		},
		/** Lists all visible notebooks without exposing encryption or deletion metadata. */
		async listAllNotebooks(signal) {
			const notebooks = await fetchAllPages('folders', { fields: 'id,title,parent_id,encryption_applied,deleted_time' }, notebookResult, signal);
			return notebooks.filter(visibleNotebook).map(({ id, title, parent_id }) => ({ id, title, parent_id: parent_id || null }));
		},
		async listNotes(options = {}, signal) {
			const { notebookId, ...page } = options;
			const route = notebookId ? `folders/${identifier(notebookId)}/notes` : 'notes';
			return request(route, { ...pagination(page), order_by: 'id', order_dir: 'ASC', fields: noteFields }, 'GET', undefined, signal, { validateResult: data => pageResult(data, noteResult) });
		},
		async listIndexNotes(options, signal) {
			// Metadata-only enumeration avoids accumulating many large bodies in one response.
			return request('notes', { ...pagination(options), order_by: 'id', order_dir: 'ASC', fields: 'id' }, 'GET', undefined, signal, { validateResult: data => pageResult(data, noteResult) });
		},
		async getNote(id, signal) {
			return request(`notes/${identifier(id)}`, { fields: noteFields }, 'GET', undefined, signal, { validateResult: noteResult });
		},
		/** Creates a note without passing user Markdown through the media-extracting POST route. */
		async createNote(input, signal) {
			const postBody = noteInput(input, true);
			const body = postBody.body;
			if (body) postBody.body = '';
			const created = await request('notes', {}, 'POST', postBody, signal, {
				validateResult(data) { identifier(data?.id); return body ? data : noteResult(data); },
			});
			try {
				return body ? await request(`notes/${created.id}`, {}, 'PUT', { body }, signal, { validateResult: noteResult }) : created;
			} catch (cause) {
				// A successful POST may already have created the note; never conceal that uncertain outcome.
				throw new ServiceError('write_outcome_unknown', true, 'write_outcome_unknown', { cause });
			}
		},
		/** Applies a partial note update, including notebook moves and todo fields. */
		async updateNote(id, input, signal) {
			return request(`notes/${identifier(id)}`, {}, 'PUT', noteInput(input, false), signal, { validateResult: noteResult });
		},
		/** Moves a note to Joplin Trash without permanently deleting it. */
		async deleteNote(id, signal) {
			await request(`notes/${identifier(id)}`, {}, 'DELETE', undefined, signal);
		},
		/** Lists every decrypted tag attached to a note. */
		async getNoteTags(noteId, signal) {
			const tags = await fetchAllPages(`notes/${identifier(noteId)}/tags`, { fields: 'id,title,encryption_applied' }, tagResult, signal);
			return tags.filter(tag => tag.encryption_applied === 0).map(({ id, title }) => ({ id, title }));
		},
		/** Lists every decrypted tag. */
		async listAllTags(signal) {
			const tags = await fetchAllPages('tags', { fields: 'id,title,encryption_applied' }, tagResult, signal);
			return tags.filter(tag => tag.encryption_applied === 0).map(({ id, title }) => ({ id, title }));
		},
		/** Creates a tag and returns only its stable identity and title. */
		async createTag(title, signal) {
			requireValue(typeof title === 'string' && title.trim().length > 0, 'invalid_tag_input');
			return request('tags', {}, 'POST', { title }, signal, { validateResult(data) {
				const tag = tagResult(data);
				return { id: tag.id, title: tag.title };
			} });
		},
		/** Attaches a tag to a note using Joplin's tag-to-note API route. */
		async addTagToNote(tagId, noteId, signal) {
			const tag = identifier(tagId);
			const note = identifier(noteId);
			await request(`tags/${tag}/notes`, {}, 'POST', { id: note }, signal, { allowEmptyPost: true });
		},
		/** Removes a tag from a note. */
		async removeTagFromNote(tagId, noteId, signal) {
			await request(`tags/${identifier(tagId)}/notes/${identifier(noteId)}`, {}, 'DELETE', undefined, signal);
		},
		/** Creates a notebook after validating its title and optional parent. */
		async createNotebook({ title, parentId }, signal) {
			requireValue(typeof title === 'string' && title.trim().length > 0, 'invalid_notebook_input');
			if (parentId !== undefined) identifier(parentId);
			return request('folders', {}, 'POST', { title, ...(parentId ? { parent_id: parentId } : {}) }, signal, { validateResult(data) {
				requireValue(data && typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id) && typeof data.title === 'string', 'invalid_backend_response');
				if (Object.hasOwn(data, 'parent_id')) requireValue(typeof data.parent_id === 'string', 'invalid_backend_response');
				return { id: data.id, title: data.title, parent_id: data.parent_id || null };
			} });
		},
		async search(query, options, signal) {
			requireValue(typeof query === 'string' && query.trim().length > 0, 'invalid_query');
			return request('search', { query, ...pagination(options), type: 'note', fields: noteFields }, 'GET', undefined, signal, { validateResult: data => pageResult(data, noteResult) });
		},
		/** Counts all eligible keyword matches using metadata-only search pages. */
		async countSearchResults(query, signal) {
			requireValue(typeof query === 'string' && query.trim().length > 0, 'invalid_query');
			let count = 0;
			let page = 1;
			let hasMore = true;
			while (hasMore) {
				const result = await request('search', {
					query,
					type: 'note',
					fields: 'id,encryption_applied,deleted_time,is_locked',
					limit: 100,
					page,
				}, 'GET', undefined, signal, { validateResult: data => pageResult(data, noteResult) });
				for (const note of result.items) {
					if (note.encryption_applied === 0 && !note.deleted_time && !note.is_locked) count++;
				}
				hasMore = result.hasMore;
				page++;
			}
			return count;
		},
		async changes(cursor, signal) {
			requireValue(cursor === undefined || (typeof cursor === 'string' && /^\d+$/.test(cursor)), 'invalid_cursor');
			return request('events', cursor === undefined ? {} : { cursor }, 'GET', undefined, signal, { validateResult(data) {
				requireValue(data && typeof data.cursor === 'string' && /^\d+$/.test(data.cursor), 'invalid_backend_response');
				const result = pageResult(data, item => {
					requireValue(item && Number.isSafeInteger(item.id) && typeof item.item_id === 'string' && Number.isSafeInteger(item.type), 'invalid_backend_response');
					return { id: item.id, itemId: item.item_id, itemType: item.item_type, type: item.type, createdTime: item.created_time };
				});
				return { ...result, cursor: data.cursor };
			} });
		},
	});
}
