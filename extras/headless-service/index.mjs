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

function eligible(note) {
	return note.encryption_applied === 0 && !note.deleted_time && !note.is_locked;
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
				status() { permit('read'); return { accountId, semantic: semantic()?.status() ?? semanticStatus }; },
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
				async getNotebook(id, signal) { permit('read'); return backend().getNotebook(id, signal); },
				async getWebCreationRecord(id, signal) { permit('write'); return backend().getClipRecord(id, signal); },
				async createWebPlaceholder(input, signal) { permit('write'); return backend().createWebPlaceholder(input, signal); },
				async getNote(id, signal) { permit('read'); return readable(await backend().getNote(id, signal)); },
				async createNote(input, signal) { permit('write'); return identity(await backend().createNote(input, signal)); },
				async updateNote(id, input, signal) {
					permit('write');
					// Best-effort eligibility check, NOT a compare-and-swap or lost-update guarantee.
					const current = await backend().getNote(id, signal);
					if (!eligible(current)) throw new ServiceError('note_unavailable');
					if (current.markup_language !== 1) throw new ServiceError('unsupported_note_format');
					return identity(await backend().updateNote(id, input, signal));
				},
				async search({ query, mode = 'keyword', ...options }, signal) {
					permit('read');
					requireValue(['keyword', 'semantic', 'hybrid'].includes(mode), 'invalid_search_mode');
					requireValue(typeof query === 'string' && query.trim().length > 0 && query.length <= 10000, 'invalid_query');
					pagination(options);
					if (signal?.aborted) throw new ServiceError('request_cancelled');
					if (mode !== 'keyword' && semantic()) return semantic().search({ query, mode, ...options }, signal);
					requireValue(!options.notebookId, 'notebook_filter_requires_semantic_engine');
					if (mode === 'semantic') return { accountId, requestedMode: mode, executedMode: null, semantic: semanticStatus, items: [], hasMore: false };
					const result = await backend().search(query, options, signal);
					return { accountId, requestedMode: mode, executedMode: 'keyword', semantic: semanticStatus, items: result.items.filter(eligible).map(note => ({ ...identity(note), provenance: 'keyword' })), hasMore: result.hasMore };
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
