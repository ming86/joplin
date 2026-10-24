import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindEmbeddingProvider } from '../src/embeddings.mjs';
import { logOperationError } from '../src/diagnostics.mjs';
import { ServiceError } from '../src/errors.mjs';
import { createEmbeddingTransport } from '../src/semantic/http.mjs';
import { openMcpRuntime } from '../src/semantic/runtime.mjs';
import { space } from './fixtures.mjs';

/** Secret-like text used to check that provider inputs and responses stay out of logs. */
const privateText = 'PRIVATE_PROMPT_AND_PROVIDER_RESPONSE';

/** Returns the error from a rejected promise without changing its identity. */
async function rejection(promise) {
	try { await promise; assert.fail('Expected the operation to fail'); }
	catch (error) { return error; }
}

/** Creates a transport pointed at a loopback URL, with no real network fallback. */
function transport(fetchImpl, options = {}) {
	return createEmbeddingTransport({
		baseUrl: 'http://127.0.0.1:11434/v1', model: 'private-model', remoteProcessing: false,
		apiKey: 'private-api-key', timeoutMs: 321, ...options,
	}, fetchImpl);
}

test('HTTP status failures retain safe request metadata, authorization codes, and retry timing', async t => {
	const logged = t.mock.method(console, 'error', () => {});
	for (const [status, code, headers, retryAfterMs] of [
		[500, 'embedding_provider_unavailable', {}, undefined],
		[401, 'embedding_authorization_failed', {}, undefined],
		[429, 'embedding_rate_limited', { 'retry-after': '30' }, 30000],
	]) {
		const request = transport(async (url, options) => {
			assert.equal(new URL(url).pathname, '/v1/embeddings');
			assert.equal(new URL(url).search, '');
			assert.equal(options.method, 'POST');
			assert.equal(options.headers.Authorization, 'Bearer private-api-key');
			assert.equal(JSON.parse(options.body).input[0], privateText);
			return new Response(`provider detail ${privateText}`, { status, headers });
		});
		const error = await rejection(request([privateText], 'query'));
		assert.equal(error.code, code);
		assert.equal(error.retryAfterMs, retryAfterMs);
		assert.equal(error.diagnostics.method, 'POST');
		assert.equal(error.diagnostics.path, 'embeddings');
		assert.equal(error.diagnostics.stage, 'http_response');
		assert.equal(error.diagnostics.status, status);
		assert.equal(error.diagnostics.timeoutMs, 321);
		assert.equal(typeof error.diagnostics.elapsedMs, 'number');
		assert.equal('url' in error.diagnostics, false);
		assert.equal('body' in error.diagnostics, false);
		assert.equal('headers' in error.diagnostics, false);
		assert.equal(logOperationError(error, { operation: 'semantic_test_embedding' }), true);
	}
	assert.equal(logged.mock.callCount(), 3);
	for (const call of logged.mock.calls) {
		const record = call.arguments[0];
		assert.equal(record.includes(privateText), false);
		assert.equal(record.includes('private-api-key'), false);
		assert.equal(record.includes('provider detail'), false);
		assert.equal(record.includes('private-model'), false);
	}
});

test('network errors retain their cause and safe diagnostics without logging request text', async t => {
	const original = Object.assign(new Error(`connection detail ${privateText}`), { code: 'ECONNREFUSED' });
	const request = transport(async () => { throw original; });
	const error = await rejection(request([privateText], 'query'));
	assert.equal(error.code, 'embedding_provider_unavailable');
	assert.equal(error.cause, original);
	assert.equal(error.diagnostics.method, 'POST');
	assert.equal(error.diagnostics.path, 'embeddings');
	assert.equal(error.diagnostics.stage, 'fetch');
	assert.equal(error.diagnostics.timeoutMs, 321);
	assert.equal('status' in error.diagnostics, false);

	const logged = t.mock.method(console, 'error', () => {});
	assert.equal(logOperationError(error), true);
	const record = logged.mock.calls[0].arguments[0];
	assert.equal(record.includes('ECONNREFUSED'), true);
	assert.equal(record.includes(privateText), false);
});

test('timeout keeps the native timeout cause; caller cancellation remains quiet', async t => {
	const keepAlive = setInterval(() => {}, 1000);
	t.after(() => clearInterval(keepAlive));
	const waitForAbort = async (_url, { signal }) => new Promise((resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
	const timed = await rejection(transport(waitForAbort, { timeoutMs: 15 })([privateText], 'query'));
	assert.equal(timed.code, 'embedding_provider_unavailable');
	assert.equal(timed.cause.name, 'TimeoutError');
	assert.equal(timed.diagnostics.stage, 'fetch');
	assert.equal(timed.diagnostics.timeoutMs, 15);

	const controller = new AbortController();
	const pending = transport(waitForAbort, { timeoutMs: 10000 })([privateText], 'query', controller.signal);
	controller.abort();
	const cancelled = await rejection(pending);
	assert.equal(cancelled.code, 'request_cancelled');
	assert.equal(cancelled.cause, controller.signal.reason);
	assert.equal(cancelled.diagnostics.stage, 'fetch');
	const logged = t.mock.method(console, 'error', () => {});
	assert.equal(logOperationError(cancelled), false);
	assert.equal(logged.mock.callCount(), 0);
});

test('malformed provider JSON retains its parse cause and never logs response or prompt text', async t => {
	const request = transport(async () => new Response(`{"detail":"${privateText}", broken}`, { status: 200 }));
	const error = await rejection(request([privateText], 'query'));
	assert.equal(error.code, 'embedding_provider_unavailable');
	assert(error.cause instanceof SyntaxError);
	assert.equal(error.diagnostics.status, 200);
	assert.equal(error.diagnostics.stage, 'parse_response');
	const logged = t.mock.method(console, 'error', () => {});
	assert.equal(logOperationError(error), true);
	const record = logged.mock.calls[0].arguments[0];
	assert.equal(record.includes(privateText), false);
	assert.equal(JSON.parse(record).errors.at(-1).message, 'Invalid JSON response');
});

test('embedding provider wrapper preserves the original transport cause', async () => {
	const original = new Error(`private transport detail ${privateText}`);
	const provider = bindEmbeddingProvider(space, async () => { throw original; });
	const error = await rejection(provider.embed([privateText], 'query'));
	assert.equal(error.code, 'embedding_provider_unavailable');
	assert.equal(error.cause, original);
	assert.equal(JSON.stringify(error).includes(privateText), false);
});

test('invalid embedding vectors carry validation-stage diagnostics and log once without response text', async t => {
	const provider = bindEmbeddingProvider(space, async () => ({
		data: [{ index: 0, embedding: [1], detail: privateText }], detail: privateText,
	}));
	const error = await rejection(provider.embed([privateText], 'query'));
	assert.equal(error.code, 'invalid_embedding_response');
	assert.equal(error.cause, undefined);
	assert.deepEqual(error.diagnostics, { stage: 'validate_embedding_response' });
	const logged = t.mock.method(console, 'error', () => {});
	assert.equal(logOperationError(error, { operation: 'semantic_test_embedding' }), true);
	assert.equal(logOperationError(error), false);
	assert.equal(logged.mock.callCount(), 1);
	assert.equal(logged.mock.calls[0].arguments[0].includes(privateText), false);
});

test('unexpected semantic startup failure logs once and its chunk fallback rejects with the startup reason', async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-diagnostics-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const tokenFile = path.join(directory, 'api-token');
	fs.writeFileSync(tokenFile, 'private-api-token', { mode: 0o600 });
	const configFile = path.join(directory, 'mcp.json');
	const config = {
		accountId: 'semantic-diagnostics', baseUrl: 'http://127.0.0.1:41184', apiTokenFile: tokenFile,
		semanticDatabasePath: path.join(directory, 'semantic.sqlite'),
		semantic: {
			enabled: true, keyFile: path.join(directory, 'semantic-key'),
			embedding: {
				protocol: 'openai-embeddings', baseUrl: 'http://127.0.0.1:11434/v1',
				model: 'private-model', remoteProcessing: false,
				apiKeyFile: path.join(directory, 'missing-provider-key'), space,
			},
		},
	};
	fs.writeFileSync(configFile, JSON.stringify(config));
	const logged = t.mock.method(console, 'error', () => {});
	const runtime = await openMcpRuntime(configFile, { background: false });
	t.after(() => runtime.close());
	assert.deepEqual(runtime.engine.status(), { state: 'unavailable', reason: 'semantic_startup_unavailable' });
	const error = await rejection(runtime.engine.searchChunks({ query: privateText }));
	assert(error instanceof ServiceError);
	assert.equal(error.code, 'semantic_startup_unavailable');
	const serviceError = await rejection(runtime.service.semanticSearchNotes({ query: privateText }));
	assert.equal(serviceError.code, 'semantic_startup_unavailable');
	assert.equal(logged.mock.callCount(), 1);
	const record = logged.mock.calls[0].arguments[0];
	assert.equal(record.includes('private-api-token'), false);
	assert.equal(record.includes('private-model'), false);
	assert.equal(record.includes(privateText), false);
	assert.equal(JSON.parse(record).operation, 'semantic_startup');
});

test('invalid semantic configuration still fails startup instead of creating an unavailable result', async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-invalid-config-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const tokenFile = path.join(directory, 'api-token');
	fs.writeFileSync(tokenFile, 'private-api-token', { mode: 0o600 });
	const configFile = path.join(directory, 'mcp.json');
	fs.writeFileSync(configFile, JSON.stringify({
		accountId: 'semantic-invalid-config', baseUrl: 'http://127.0.0.1:41184', apiTokenFile: tokenFile,
		semantic: { enabled: true, unsupportedSetting: true },
	}));
	await assert.rejects(openMcpRuntime(configFile), error => error.code === 'invalid_semantic_configuration');
});

test('invalid semantic key is visible in startup diagnostics while disabled semantic stays quiet', async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-invalid-key-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const tokenFile = path.join(directory, 'api-token');
	fs.writeFileSync(tokenFile, 'private-api-token', { mode: 0o600 });
	const keyFile = path.join(directory, 'semantic-key');
	fs.writeFileSync(keyFile, 'private-invalid-semantic-key', { mode: 0o600 });
	const configFile = path.join(directory, 'mcp.json');
	const config = {
		accountId: 'semantic-invalid-key', baseUrl: 'http://127.0.0.1:41184', apiTokenFile: tokenFile,
		semanticDatabasePath: path.join(directory, 'semantic.sqlite'),
		semantic: {
			enabled: true, keyFile, sqliteModule: path.join(directory, 'unused-sqlcipher-module.cjs'),
			embedding: {
				protocol: 'openai-embeddings', baseUrl: 'http://127.0.0.1:11434/v1',
				model: 'private-model', remoteProcessing: false, space,
			},
		},
	};
	fs.writeFileSync(configFile, JSON.stringify(config));
	const logged = t.mock.method(console, 'error', () => {});
	const runtime = await openMcpRuntime(configFile, { background: false });
	t.after(() => runtime.close());
	assert.deepEqual(runtime.engine.status(), { state: 'unavailable', reason: 'invalid_semantic_key' });
	assert.equal(logged.mock.callCount(), 1);
	const record = logged.mock.calls[0].arguments[0];
	const errors = JSON.parse(record).errors;
	assert.equal(JSON.parse(record).operation, 'semantic_startup');
	assert.deepEqual(errors.slice(0, 2).map(error => error.code), ['semantic_startup_unavailable', 'invalid_semantic_key']);
	assert.equal(record.includes('private-invalid-semantic-key'), false);
	assert.equal(record.includes('private-api-token'), false);
	assert.equal(record.includes('private-model'), false);

	const disabledConfigFile = path.join(directory, 'disabled-mcp.json');
	fs.writeFileSync(disabledConfigFile, JSON.stringify({
		accountId: 'semantic-disabled', baseUrl: 'http://127.0.0.1:41185', apiTokenFile: tokenFile,
		semantic: { enabled: false },
	}));
	const disabled = await openMcpRuntime(disabledConfigFile, { background: false });
	t.after(() => disabled.close());
	assert.equal(disabled.engine, undefined);
	assert.equal(logged.mock.callCount(), 1);
});

test('semantic_store_unavailable startup failures are logged even without a native cause', async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-store-unavailable-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const tokenFile = path.join(directory, 'api-token');
	fs.writeFileSync(tokenFile, 'private-api-token', { mode: 0o600 });
	const keyFile = path.join(directory, 'semantic-key');
	fs.writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 });
	const configFile = path.join(directory, 'mcp.json');
	fs.writeFileSync(configFile, JSON.stringify({
		accountId: 'semantic-store-unavailable', baseUrl: 'http://127.0.0.1:41184', apiTokenFile: tokenFile,
		semanticDatabasePath: path.join(directory, 'semantic.sqlite'),
		semantic: {
			enabled: true, keyFile, sqliteModule: path.join(directory, 'missing-sqlcipher-module.cjs'),
			embedding: {
				protocol: 'openai-embeddings', baseUrl: 'http://127.0.0.1:11434/v1',
				model: 'private-model', remoteProcessing: false, space,
			},
		},
	}));
	const logged = t.mock.method(console, 'error', () => {});
	const runtime = await openMcpRuntime(configFile, { background: false });
	t.after(() => runtime.close());
	assert.deepEqual(runtime.engine.status(), { state: 'unavailable', reason: 'semantic_store_unavailable' });
	assert.equal(logged.mock.callCount(), 1);
	const record = logged.mock.calls[0].arguments[0];
	assert.deepEqual(JSON.parse(record).errors.slice(0, 2).map(error => error.code), ['semantic_startup_unavailable', 'semantic_store_unavailable']);
	assert.equal(record.includes('private-api-token'), false);
	assert.equal(record.includes('private-model'), false);
});
