import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ServiceError } from '../src/errors.mjs';
import { logOperationError, withDiagnostics } from '../src/diagnostics.mjs';
import { createJoplinClient } from '../src/joplin.mjs';

/** Valid note identity used to exercise backend requests. */
const noteId = 'a'.repeat(32);
/** Private sentinel that must never enter diagnostic output. */
const secret = 'PRIVATE_NOTE_CONTENT_AND_TOKEN';

/** Builds the JSON client with a deliberately recognizable private token. */
function client(options = {}) {
	return createJoplinClient({ baseUrl: 'http://127.0.0.1:41184/', token: secret, ...options });
}

/** Captures a rejection without replacing the original error object. */
async function failure(promise) {
	try { await promise; assert.fail('Expected request to fail'); }
	catch (error) { return error; }
}

test('native localhost connection failure retains its cause and emits useful diagnostics once', async t => {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	const error = await failure(client({ baseUrl: `http://127.0.0.1:${port}/` }).getNote(noteId));
	assert.equal(error.code, 'backend_unavailable');
	assert.equal(error.cause.message, 'fetch failed');
	assert.equal(error.cause.cause.code, 'ECONNREFUSED');
	const output = t.mock.method(console, 'error', () => {});
	assert.equal(logOperationError(error, { tool: 'get_note' }), true);
	assert.equal(logOperationError(error, { operation: 'outer_boundary' }), false);
	assert.equal(output.mock.callCount(), 1);
	const record = JSON.parse(output.mock.calls[0].arguments[0]);
	assert.equal(record.tool, 'get_note');
	assert.equal(record.method, 'GET');
	assert.equal(record.path, `notes/${noteId}`);
	assert.equal(record.stage, 'fetch');
	assert.equal(record.timeoutMs, 10000);
	assert.equal(typeof record.elapsedMs, 'number');
	assert.equal(record.errors.at(-1).code, 'ECONNREFUSED');
	assert.equal(JSON.stringify(record).includes(secret), false);
});

test('malformed JSON preserves the SyntaxError but never logs its response excerpt', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response(`{"body":"${secret}", invalid}`));
	const error = await failure(client().getNote(noteId));
	assert.equal(error.code, 'backend_unavailable');
	assert(error.cause instanceof SyntaxError);
	assert.equal(error.diagnostics.status, 200);
	assert.equal(error.diagnostics.stage, 'parse_response');
	const output = t.mock.method(console, 'error', () => {});
	logOperationError(error, { tool: 'get_note' });
	const line = output.mock.calls[0].arguments[0];
	assert.equal(line.includes(secret), false);
	assert.equal(JSON.parse(line).errors[1].message, 'Invalid JSON response');
});

test('HTTP failure records status without reading private error bodies and never retries a write', async t => {
	const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(secret, { status: 503 }));
	const error = await failure(client().updateNote(noteId, { body: secret }));
	assert.equal(error.code, 'write_outcome_unknown');
	assert.equal(error.outcomeUnknown, true);
	assert.equal(error.diagnostics.status, 503);
	assert.equal(error.diagnostics.method, 'PUT');
	assert.equal(error.diagnostics.stage, 'http_response');
	assert.equal(fetch.mock.callCount(), 1);
	const output = t.mock.method(console, 'error', () => {});
	logOperationError(error, { tool: 'update_note' });
	assert.equal(output.mock.calls[0].arguments[0].includes(secret), false);
});

test('response body failure keeps its original network code and write uncertainty', async t => {
	const original = Object.assign(new Error(`private ${secret}`), { code: 'ECONNRESET' });
	t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, text: async () => { throw original; } }));
	const error = await failure(client().updateNote(noteId, { title: secret }));
	assert.equal(error.code, 'write_outcome_unknown');
	assert.equal(error.cause, original);
	assert.equal(error.diagnostics.stage, 'read_response');
	const output = t.mock.method(console, 'error', () => {});
	logOperationError(error);
	const line = output.mock.calls[0].arguments[0];
	assert.equal(line.includes('ECONNRESET'), true);
	assert.equal(line.includes(secret), false);
});

test('timeout, caller cancellation, and pre-cancelled writes retain their existing public behavior', async t => {
	// Keep the event loop alive while native AbortSignal.timeout triggers its unreferenced timer.
	const keepAlive = setInterval(() => {}, 1000);
	t.after(() => clearInterval(keepAlive));
	const fetch = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
		await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
	});
	const timeout = await failure(client({ timeoutMs: 10 }).getNote(noteId));
	assert.equal(timeout.code, 'backend_unavailable');
	assert.equal(timeout.cause.name, 'TimeoutError');
	assert.equal(timeout.diagnostics.timeoutMs, 10);
	const controller = new AbortController();
	const pending = client().getNote(noteId, controller.signal);
	controller.abort();
	const cancelled = await failure(pending);
	assert.equal(cancelled.code, 'request_cancelled');
	assert.equal(cancelled.cause, controller.signal.reason);
	assert.equal(logOperationError(cancelled), false);
	const calls = fetch.mock.callCount();
	const preCancelled = await failure(client().updateNote(noteId, { title: secret }, controller.signal));
	assert.equal(preCancelled.code, 'request_cancelled');
	assert.equal(preCancelled.outcomeUnknown, false);
	assert.equal(fetch.mock.callCount(), calls);
});

test('malformed successful writes retain validation causes and request context without retry', async t => {
	const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'bad', title: secret }));
	const error = await failure(client().updateNote(noteId, { title: secret }));
	assert.equal(error.code, 'write_outcome_unknown');
	assert.equal(error.cause.code, 'invalid_backend_response');
	assert.equal(error.diagnostics.stage, 'validate_response');
	assert.equal(error.diagnostics.status, 200);
	assert.equal(fetch.mock.callCount(), 1);
});

test('malformed read results keep their public code and include the completed request context', async t => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ body: secret }));
	for (const [invoke, method, path] of [
		[api => api.getNote(noteId), 'GET', `notes/${noteId}`],
		[api => api.listNotes(), 'GET', 'notes'],
		[api => api.status(), 'POST', 'services/headless'],
	]) {
		const error = await failure(invoke(client()));
		assert.equal(error.code, 'invalid_backend_response');
		assert.equal(error.outcomeUnknown, false);
		assert.equal(error.diagnostics.method, method);
		assert.equal(error.diagnostics.path, path);
		assert.equal(error.diagnostics.status, 200);
		assert.equal(error.diagnostics.stage, 'validate_response');
		assert.equal(typeof error.diagnostics.elapsedMs, 'number');
	}
});

test('validation public text stays unchanged and expected failures stay quiet', async t => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'validation_error', error: 'The title is required.' }, { status: 400 }));
	const error = await failure(client().createTag('title'));
	assert.equal(error.code, 'validation_error');
	assert.equal(error.message, 'The title is required.');
	assert.equal(error.outcomeUnknown, false);
	assert.equal(logOperationError(error, { tool: 'create_tag' }), false);
	assert.equal(logOperationError(withDiagnostics(new ServiceError('note_conflict'), { path: 'services/headless', status: 200 })), false);
});

test('outer wrappers keep nested metadata and logging excludes arbitrary messages and fields', t => {
	const original = Object.assign(new Error(`https://user:${secret}@example.test/a?token=${secret}`), { code: 'ETIMEDOUT', token: secret });
	original.stack = `Error: ${secret}\n    at call (file:///safe/client.mjs?token=${secret}:10:2)\n    at call (file:///safe/client.mjs:11:3)`;
	const inner = new ServiceError('backend_unavailable', false, 'backend_unavailable', { cause: original, diagnostics: { method: 'GET', path: 'notes/:id', status: 200, body: secret, url: secret } });
	const outer = new ServiceError('write_outcome_unknown', true, 'write_outcome_unknown', { cause: inner });
	const output = t.mock.method(console, 'error', () => {});
	assert.equal(logOperationError(outer, { operation: 'read_note_file' }), true);
	assert.equal(logOperationError(inner), false);
	const line = output.mock.calls[0].arguments[0];
	const record = JSON.parse(line);
	assert.equal(record.path, 'notes/:id');
	assert.equal(record.errors.at(-1).code, 'ETIMEDOUT');
	assert.deepEqual(record.errors.at(-1).stack, ['file:///safe/client.mjs:11:3']);
	assert.equal(line.includes(secret), false);
	assert.equal(outer.cause, inner);
	assert.equal(inner.cause, original);
});

test('aggregate network failures retain the individual native connection codes', t => {
	const connections = new AggregateError([
		Object.assign(new Error(secret), { code: 'ECONNREFUSED' }),
		Object.assign(new Error(secret), { code: 'ENETUNREACH' }),
	], secret);
	const original = new TypeError('fetch failed', { cause: connections });
	const error = new ServiceError('backend_unavailable', false, 'backend_unavailable', { cause: original });
	const output = t.mock.method(console, 'error', () => {});
	logOperationError(error, { tool: 'get_note' });
	const line = output.mock.calls[0].arguments[0];
	const record = JSON.parse(line);
	assert.deepEqual(record.errors.slice(-2).map(item => item.code), ['ECONNREFUSED', 'ENETUNREACH']);
	assert.equal(line.includes(secret), false);
});
