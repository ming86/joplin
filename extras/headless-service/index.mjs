import path from 'node:path';
import fs from 'node:fs';
import { createJoplinClient, endpoint } from './src/joplin.mjs';
import { bindEmbeddingProvider, embeddingSpace } from './src/embeddings.mjs';
import { requireValue, ServiceError, pagination } from './src/errors.mjs';
export { ServiceError } from './src/errors.mjs';
export { bindEmbeddingProvider, embeddingSpace, embeddingFingerprint, noteFingerprint } from './src/embeddings.mjs';

function canonicalPlannedPath(value) {
	requireValue(typeof value === 'string' && path.isAbsolute(value));
	let existing = path.resolve(value);
	const suffix = [];
	while (!fs.existsSync(existing)) {
		suffix.unshift(path.basename(existing));
		const parent = path.dirname(existing);
		requireValue(parent !== existing);
		existing = parent;
	}
	return path.join(fs.realpathSync(existing), ...suffix);
}

function configuredAccount(config) {
	requireValue(config && typeof config.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.id));
	requireValue(Array.isArray(config.subjects) && config.subjects.length > 0 && config.subjects.every(subject => typeof subject === 'string' && subject.length > 0));
	const permissions = config.permissions ?? ['read'];
	requireValue(Array.isArray(permissions) && permissions.every(value => value === 'read' || value === 'write'));
	requireValue(config.joplin && config.semantic);
	requireValue(typeof config.semantic.keyRef === 'string' && config.semantic.keyRef.length > 0);
	const result = structuredClone(config);
	result.permissions = permissions.slice();
	result.joplin.baseUrl = endpoint(result.joplin.baseUrl, result.joplin.allowInsecureHttp);
	requireValue(typeof result.joplin.token === 'string' && result.joplin.token.length > 0);
	if (result.defaultNotebookId !== undefined) requireValue(typeof result.defaultNotebookId === 'string' && /^[a-f0-9]{32}$/.test(result.defaultNotebookId));
	result.semantic.databasePath = canonicalPlannedPath(result.semantic.databasePath);
	if (result.embedding) {
		result.embedding.space = embeddingSpace(result.embedding.space);
		requireValue(result.embedding.protocol === 'openai-embeddings');
		requireValue(typeof result.embedding.model === 'string' && result.embedding.model.length > 0);
		result.embedding.baseUrl = endpoint(result.embedding.baseUrl, result.embedding.allowInsecureHttp);
		requireValue(typeof result.embedding.remoteProcessing === 'boolean');
		const host = new URL(result.embedding.baseUrl).hostname;
		if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) requireValue(result.embedding.remoteProcessing, 'remote_processing_not_allowed');
		// A loopback proxy can itself be remote. This declaration is an operator policy, not an egress firewall.
	}
	return result;
}

/** Notes with incomplete encryption metadata are ineligible as well. */
function eligible(note) {
	return note.encryption_applied === 0 && !note.deleted_time && !note.is_locked;
}

/** Return whether a value is a plain input record supplied to an account operation. */
function inputRecord(value, code = 'invalid_input') {
	requireValue(value && typeof value === 'object' && !Array.isArray(value), code);
	return value;
}

/** Resolve only subjects verified by your authentication layer, never request-provided identities.
 * Factories and configurations are trusted startup inputs, not API/tool parameters.
 * No singleton account, direct SQL access, network listener or provider request is created here.
 */
export function createAccountRegistry(configurations, factories = {}) {
	requireValue(Array.isArray(configurations) && configurations.length > 0);
	const accounts = new Map();
	const paths = new Set();
	const keys = new Set();
	const endpoints = new Set();
	for (const input of configurations) {
		const config = configuredAccount(input);
		requireValue(!accounts.has(config.id) && !paths.has(config.semantic.databasePath) && !keys.has(config.semantic.keyRef) && !endpoints.has(config.joplin.baseUrl), 'duplicate_account_binding');
		accounts.set(config.id, config);
		paths.add(config.semantic.databasePath); keys.add(config.semantic.keyRef); endpoints.add(config.joplin.baseUrl);
	}
	const backends = new Map();
	const providers = new Map();
	const semanticBackends = new Map();
	return Object.freeze({
		forPrincipal(subject, accountId) {
			const config = accounts.get(accountId);
			if (typeof subject !== 'string' || !config || !config.subjects.includes(subject)) throw new ServiceError('account_not_available');
			const permit = permission => {
				if (!config.permissions.includes(permission)) throw new ServiceError('operation_not_permitted');
			};
			const backend = () => {
				if (!backends.has(accountId)) backends.set(accountId, factories.makeBackend ? factories.makeBackend(structuredClone(config)) : createJoplinClient(config.joplin));
				return backends.get(accountId);
			};
			const identity = note => ({ ...note, accountId });
			const readable = note => { if (!eligible(note)) throw new ServiceError('note_unavailable'); return identity(note); };
			// A missing or hidden parent folder does not make an otherwise readable note unreadable.
			const readableNotebookTitle = async (id, signal) => {
				try { return (await backend().getNotebook(id, signal)).title; }
				catch (error) {
					if (error?.code === 'not_found' || error?.code === 'clip_notebook_unavailable') return null;
					throw error;
				}
			};
			const semantic = () => {
				if (!factories.makeSemanticBackend) return null;
				if (!semanticBackends.has(accountId)) {
					const engine = factories.makeSemanticBackend(structuredClone(config));
					if (engine) requireValue(engine.accountId === accountId, 'semantic_account_mismatch');
					semanticBackends.set(accountId, engine);
				}
				return semanticBackends.get(accountId);
			};
			const semanticStatus = Object.freeze({ state: 'unavailable', reason: 'not_implemented', ...(config.embedding ? { embeddingSpaceId: config.embedding.space.id } : {}) });
			return Object.freeze({
				accountId,
				async status(signal) {
					permit('read');
					const semanticState = semantic()?.status() ?? semanticStatus;
					return { accountId, semantic: semanticState, ...await backend().status(signal) };
				},
				async listNotebooks(options, signal) {
					permit('read'); const result = await backend().listNotebooks(options, signal);
					return { ...result, items: result.items.map(identity) };
				},
				async listNotes(options, signal) {
					permit('read'); const result = await backend().listNotes(options, signal);
					return { ...result, items: result.items.filter(eligible).map(identity) };
				},
				async listNoteSummaries(options, signal) {
					permit('read'); const result = await backend().listNoteSummaries(options, signal);
					return { ...result, items: result.items.filter(eligible).map(identity) };
				},
				/** List every readable notebook with counts from eligible note summaries. */
				async listAllNotebooks(signal) {
					permit('read');
					const folders = await backend().listAllNotebooks(signal);
					const counts = new Map(folders.map(folder => [folder.id, 0]));
					let page = 1;
					let hasMore = true;
					// Count from note metadata so hidden, deleted, and encrypted items never affect output.
					while (hasMore) {
						const result = await backend().listNoteSummaries({ page, limit: 100 }, signal);
						for (const note of result.items) {
							if (eligible(note) && counts.has(note.parent_id)) counts.set(note.parent_id, counts.get(note.parent_id) + 1);
						}
						hasMore = result.hasMore;
						page++;
					}
					return {
						accountId,
						notebooks: folders.map(folder => ({
							id: folder.id,
							title: folder.title,
							parent_id: folder.parent_id || null,
							note_count: counts.get(folder.id) ?? 0,
						})),
					};
				},
				async getNotebook(id, signal) { permit('read'); return backend().getNotebook(id, signal); },
				/** Create a notebook under a verified readable parent when one is supplied. */
				async createNotebook(input, signal) {
					permit('write'); inputRecord(input, 'invalid_notebook_input');
					requireValue(Object.keys(input).every(key => ['title', 'parent_id'].includes(key)), 'unsupported_notebook_property');
					requireValue(typeof input.title === 'string' && input.title.trim().length > 0, 'invalid_notebook_input');
					if (input.parent_id !== undefined) {
						requireValue(typeof input.parent_id === 'string', 'invalid_notebook_input');
						await backend().getNotebook(input.parent_id, signal);
					}
					return backend().createNotebook({ title: input.title.trim(), ...(input.parent_id ? { parentId: input.parent_id } : {}) }, signal);
				},
				async getWebCreationRecord(id, signal) { permit('write'); return backend().getClipRecord(id, signal); },
				async createWebPlaceholder(input, signal) { permit('write'); return backend().createWebPlaceholder(input, signal); },
				async getNote(id, signal) { permit('read'); return readable(await backend().getNote(id, signal)); },
				/** Read an eligible note with its readable notebook title and tag titles. */
				async readNote(id, signal) {
					permit('read');
					const note = readable(await backend().getNote(id, signal));
					const notebook_title = note.parent_id ? await readableNotebookTitle(note.parent_id, signal) : null;
					const tags = await backend().getNoteTags(id, signal);
					return { ...note, notebook_title, tags: tags.map(tag => tag.title) };
				},
				/** Create a note in a verified notebook, accepting both Desktop and legacy web inputs. */
				async createNote(input, signal) {
					permit('write'); inputRecord(input, 'invalid_note_input');
					requireValue(Object.keys(input).every(key => ['title', 'body', 'notebook_id', 'parentId', 'is_todo'].includes(key)), 'unsupported_note_property');
					requireValue(typeof input.title === 'string', 'invalid_note_input');
					requireValue(input.title.trim().length > 0, 'invalid_note_input');
					if (input.body !== undefined) requireValue(typeof input.body === 'string', 'invalid_note_input');
					if (input.notebook_id !== undefined) requireValue(typeof input.notebook_id === 'string', 'invalid_note_input');
					if (input.parentId !== undefined) requireValue(typeof input.parentId === 'string', 'invalid_note_input');
					if (input.is_todo !== undefined) requireValue(typeof input.is_todo === 'boolean', 'invalid_note_input');
					let parentId = input.notebook_id ?? input.parentId ?? config.defaultNotebookId;
					if (parentId === undefined) {
						// hasMore tracks raw folders, including folders filtered as unreadable.
						let onlyNotebookId;
						let notebookCount = 0;
						let page = 1;
						while (true) {
							const result = await backend().listNotebooks({ page, limit: 2 }, signal);
							for (const notebook of result.items) {
								notebookCount++;
								if (notebookCount > 1) throw new ServiceError('notebook_id_required');
								onlyNotebookId = notebook.id;
							}
							if (!result.hasMore) break;
							page++;
						}
						if (notebookCount !== 1) throw new ServiceError('notebook_id_required');
						parentId = onlyNotebookId;
					}
					await backend().getNotebook(parentId, signal);
					const created = await backend().createNote({
						title: input.title,
						body: input.body ?? '',
						parentId,
						is_todo: input.is_todo ? 1 : 0,
					}, signal);
					return { ...identity(created), notebook_id: created.parent_id };
				},
				async updateNote(id, input, signal) {
					permit('write');
					inputRecord(input, 'invalid_note_input');
					requireValue(Object.keys(input).every(key => ['title', 'body', 'append', 'prepend', 'replace_text', 'notebook_id', 'todo_completed'].includes(key)), 'unsupported_note_property');
					for (const key of ['title', 'body', 'append', 'prepend']) {
						if (input[key] !== undefined) requireValue(typeof input[key] === 'string', 'invalid_note_input');
					}
					if (input.notebook_id !== undefined) requireValue(typeof input.notebook_id === 'string', 'invalid_note_input');
					if (input.todo_completed !== undefined) requireValue(typeof input.todo_completed === 'boolean', 'invalid_note_input');
					// Best-effort eligibility check, NOT a compare-and-swap or lost-update guarantee.
					const current = await backend().getNote(id, signal);
					if (!eligible(current)) throw new ServiceError('note_unavailable');
					if (current.markup_language !== 1) throw new ServiceError('unsupported_note_format');
					if (input.notebook_id !== undefined) await backend().getNotebook(input.notebook_id, signal);
					let nextBody = current.body ?? '';
					let bodyChanged = false;
					if (input.body !== undefined) {
						nextBody = input.body;
						bodyChanged = true;
					} else {
						if (input.prepend) { nextBody = `${input.prepend}${nextBody}`; bodyChanged = true; }
						if (input.append) { nextBody = `${nextBody}${input.append}`; bodyChanged = true; }
						if (input.replace_text !== undefined) {
							inputRecord(input.replace_text, 'invalid_note_input');
							requireValue(Object.keys(input.replace_text).every(key => ['find', 'replace'].includes(key)), 'unsupported_note_property');
							const { find, replace } = input.replace_text;
							requireValue(typeof find === 'string' && typeof replace === 'string', 'invalid_note_input');
							if (!find) throw new ServiceError('replace_text_empty_find');
							const firstIdx = nextBody.indexOf(find);
							if (firstIdx < 0) throw new ServiceError('replace_text_not_found');
							if (nextBody.indexOf(find, firstIdx + 1) >= 0) throw new ServiceError('replace_text_ambiguous');
							nextBody = `${nextBody.slice(0, firstIdx)}${replace}${nextBody.slice(firstIdx + find.length)}`;
							bodyChanged = true;
						}
					}
					const patch = {
						...(input.title !== undefined ? { title: input.title } : {}),
						...(bodyChanged ? { body: nextBody } : {}),
						...(input.notebook_id !== undefined ? { parentId: input.notebook_id } : {}),
						...(input.todo_completed !== undefined ? { todo_completed: input.todo_completed ? Date.now() : 0 } : {}),
					};
					return identity(await backend().updateNote(id, patch, signal));
				},
				/** Move an eligible note to Trash after checking its current state. */
				async deleteNote(id, signal) {
					permit('write');
					const current = await backend().getNote(id, signal);
					if (!eligible(current)) throw new ServiceError('note_unavailable');
					await backend().deleteNote(id, signal);
					return { id, trashed: true, accountId };
				},
				/** Create or list safe tag assignments for one eligible note. */
				async manageTags(input, signal) {
					permit('write'); inputRecord(input, 'invalid_tag_input');
					requireValue(Object.keys(input).every(key => ['note_id', 'add', 'remove'].includes(key)), 'unsupported_tag_property');
					const noteId = input.note_id;
					requireValue(typeof noteId === 'string', 'invalid_tag_input');
					const add = input.add ?? [];
					const remove = input.remove ?? [];
					requireValue(Array.isArray(add) && add.every(value => typeof value === 'string') && Array.isArray(remove) && remove.every(value => typeof value === 'string'), 'invalid_tag_input');
					if (!add.length && !remove.length) throw new ServiceError('tag_change_required');
					const current = await backend().getNote(noteId, signal);
					if (!eligible(current)) throw new ServiceError('note_unavailable');
					const knownTags = new Map((await backend().listAllTags(signal)).map(tag => [tag.title.trim().toLowerCase(), tag]));
					const added = [];
					for (const title of add) {
						const trimmed = title.trim();
						if (!trimmed) continue;
						const key = trimmed.toLowerCase();
						let tag = knownTags.get(key);
						if (!tag) {
							tag = await backend().createTag(trimmed, signal);
							knownTags.set(tag.title.trim().toLowerCase(), tag);
						}
						await backend().addTagToNote(tag.id, noteId, signal);
						added.push(trimmed);
					}
					const removed = [];
					for (const title of remove) {
						const trimmed = title.trim();
						if (!trimmed) continue;
						const tag = knownTags.get(trimmed.toLowerCase());
						if (tag) {
							await backend().removeTagFromNote(tag.id, noteId, signal);
							removed.push(trimmed);
						}
					}
					const tags = await backend().getNoteTags(noteId, signal);
					return { note_id: noteId, added, removed, tags: tags.map(tag => tag.title) };
				},
				async listTags(signal) {
					permit('read');
					return { tags: await backend().listAllTags(signal) };
				},
				async search({ query, mode = 'keyword', ...options }, signal) {
					permit('read');
					requireValue(['keyword', 'semantic', 'hybrid'].includes(mode), 'invalid_search_mode');
					requireValue(typeof query === 'string' && query.trim().length > 0, 'invalid_query');
					pagination(options);
					if (signal?.aborted) throw new ServiceError('request_cancelled');
					if (mode !== 'keyword' && semantic()) return semantic().search({ query, mode, ...options }, signal);
					requireValue(!options.notebookId, 'notebook_filter_requires_semantic_engine');
					if (mode === 'semantic') return { accountId, requestedMode: mode, executedMode: null, semantic: semanticStatus, items: [], hasMore: false };
					const result = await backend().search(query, options, signal);
					const total = backend().countSearchResults ? await backend().countSearchResults(query, signal) : undefined;
					return {
						accountId,
						requestedMode: mode,
						executedMode: 'keyword',
						semantic: semanticStatus,
						items: result.items.filter(eligible).map(note => ({ ...identity(note), provenance: 'keyword' })),
						hasMore: result.hasMore,
						...(total === undefined ? {} : { total }),
					};
				},
				async changes(cursor, signal) { permit('read'); return { ...await backend().changes(cursor, signal), accountId }; },
				async embed(texts, purpose, signal) {
					permit('read');
					if (!config.embedding) throw new ServiceError('embedding_provider_unavailable');
					if (!providers.has(accountId)) providers.set(accountId, bindEmbeddingProvider(config.embedding.space, factories.makeEmbeddingTransport?.(structuredClone(config))));
					return { ...await providers.get(accountId).embed(texts, purpose, signal), accountId };
				},
			});
		},
	});
}
