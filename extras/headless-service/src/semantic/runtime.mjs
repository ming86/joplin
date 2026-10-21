import path from 'node:path';
import { createAccountRegistry, bindEmbeddingProvider } from '../../index.mjs';
import { createJoplinClient } from '../joplin.mjs';
import { loadMcpConfig, readFile } from '../mcp/config.mjs';
import { ServiceError, requireValue } from '../errors.mjs';
import { openSemanticStore } from './store.mjs';
import { createEmbeddingTransport } from './http.mjs';
import { createSemanticEngine } from './engine.mjs';
import { chunkSettings } from './chunks.mjs';

// Optional semantic ownership is in the surrounding application, not the CLI.
// A configured but locked/missing store reports unavailable; FTS remains usable.
/**
 * Open the configured MCP service and optional semantic engine.
 * @param {string} filename Absolute path to the JSON configuration file.
 * @param {{background?: boolean, transport?: 'stdio'|'http'}} [options]
 * @returns {Promise<object>} Loaded service, runtime engine state and close function.
 */
export async function openMcpRuntime(filename, { background = true, transport = 'stdio' } = {}) {
	const loaded = loadMcpConfig(filename, { transport });
	const config = loaded.semanticConfig;
	if (config === undefined || config.enabled === false) return { ...loaded, close: async () => {} };
	requireValue(config && config.enabled === true && Object.keys(config).every(key => ['enabled', 'sqliteModule', 'keyFile', 'embedding', 'chunks', 'pollMs', 'rescanMs', 'batchSize', 'rebuild'].includes(key)), 'invalid_semantic_configuration');
	requireValue(config.embedding && Object.keys(config.embedding).every(key => ['protocol', 'baseUrl', 'model', 'remoteProcessing', 'allowInsecureHttp', 'apiKeyFile', 'space', 'timeoutMs', 'maxInputBytes', 'maxBatch', 'maxResponseBytes'].includes(key)), 'invalid_embedding_configuration');
	requireValue(config.rebuild === undefined || typeof config.rebuild === 'boolean');
	const account = loaded.accountConfig;
	const chunks = chunkSettings(config.chunks);
	requireValue(chunks.maxBytes + Buffer.byteLength(account.embedding.space.documentPrefix ?? '') <= (config.embedding.maxInputBytes ?? 8192), 'chunk_exceeds_embedding_limit');
	requireValue((config.batchSize ?? 16) <= (config.embedding.maxBatch ?? 16), 'embedding_batch_too_large');
	let engine; let close = async () => {};
	try {
		const embedding = { ...config.embedding, apiKey: config.embedding.apiKeyFile ? readFile(config.embedding.apiKeyFile, 8192, true).trim() : undefined };
		const provider = bindEmbeddingProvider(account.embedding.space, createEmbeddingTransport(embedding));
		const key = readFile(config.keyFile, 128, true).trim();
		const sqliteModule = config.sqliteModule ?? process.env.JOPLIN_HEADLESS_SQLITE_MODULE;
		requireValue(path.isAbsolute(sqliteModule ?? ''), 'semantic_sqlcipher_module_required');
		const store = await openSemanticStore({ filename: account.semantic.databasePath, accountId: account.id, key, sqliteModule, model: embedding.model, space: account.embedding.space, chunks, rebuild: config.rebuild });
		try {
			engine = createSemanticEngine({ accountId: account.id, backend: createJoplinClient(account.joplin), store, provider, chunks, pollMs: config.pollMs, rescanMs: config.rescanMs, batchSize: config.batchSize });
			await engine.initialize();
		} catch (error) { await store.close(); throw error; }
		close = () => engine.close(); if (background) engine.start();
	} catch (error) {
		const reason = error instanceof ServiceError ? error.code : 'semantic_startup_unavailable';
		const state = () => ({ state: 'unavailable', reason });
		const core = loaded.service;
		engine = {
			accountId: account.id, status: state,
			async search(input, signal) {
				if (input.mode === 'hybrid') {
					// Do not ignore an explicit scope when degraded.
					if (input.notebookId) throw new ServiceError('notebook_filter_requires_semantic_engine');
					return { ...await core.search({ ...input, mode: 'keyword' }, signal), requestedMode: 'hybrid', semantic: state() };
				}
				return { accountId: account.id, requestedMode: 'semantic', executedMode: null, semantic: state(), items: [], hasMore: false };
			},
		};
	}
	const registry = createAccountRegistry([account], { makeSemanticBackend: () => engine });
	return { ...loaded, service: registry.forPrincipal('local-stdio', account.id), engine, close };
}
