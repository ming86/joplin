import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountRegistry, ServiceError } from '../index.mjs';
import { createMcpSession } from '../mcp.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';
import { loadMcpConfig } from '../src/mcp/config.mjs';
import { account, backend, headlessStatus, noteId, folderId, server, readJson } from './fixtures.mjs';
import { StdioTestClient } from '../scripts/lib/stdio-client.mjs';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initialize = version => request(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
const call = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });
function session(options, customBackend = backend(), config = account(), factories = {}) {
	return createMcpSession(createAccountRegistry([config], { makeBackend: () => customBackend, ...factories }).forPrincipal(config.id, config.id), options);
}
async function ready(s) { await s.handle(initialize('2025-11-25')); await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); }

test('MCP negotiates both pinned versions; unknown version proposes supported version', async () => {
	for (const version of ['2025-11-25', '2025-06-18', '2099-01-01']) {
		const s = session(); const result = await s.handle(initialize(version));
		assert.equal(result.result.protocolVersion, version === '2099-01-01' ? '2025-11-25' : version);
		assert.deepEqual(result.result.capabilities, { tools: {}, resources: {} });
	}
});
test('requires valid initialization and ready notification; rejects second initialization', async () => {
	const s = session();
	assert.equal((await s.handle(call(2, 'get_note', { id: noteId }))).error.code, -32000);
	assert.equal((await s.handle(request(1, 'initialize', {}))).error.code, -32602);
	await s.handle(initialize('2025-11-25'));
	assert.ok((await s.handle(call(2, 'get_status'))).error);
	await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
	assert.equal((await s.handle(request(3, 'initialize'))).error.code, -32600);
	assert.equal((await s.handle(call(4, 'get_status'))).result.structuredContent.accountId, 'alice');
});
test('stateless sessions serve tools without a handshake and accept independent initialization requests', async () => {
	const s = session({ stateless: true });
	assert.equal((await s.handle(request(2, 'tools/list'))).result.tools.length, 18);
	assert.equal((await s.handle(call(3, 'get_status'))).result.structuredContent.accountId, 'alice');
	assert.equal((await s.handle(initialize('2025-11-25'))).result.protocolVersion, '2025-11-25');
	assert.equal((await s.handle(initialize('2025-06-18'))).result.protocolVersion, '2025-06-18');
	assert.equal((await s.handle(request(4, 'initialize', {}))).error.code, -32602);
	s.close();
	assert.equal((await s.handle(request(5, 'tools/list'))).error.code, -32000);
});
test('get_status returns sync/decryption details, forwards cancellation, and reports backend failure', async () => {
	let seenSignal;
	const b = backend();
	b.status = async signal => { seenSignal = signal; return structuredClone(headlessStatus); };
	const s = session({}, b); await ready(s);
	const result = (await s.handle(call(2, 'get_status'))).result;
	assert.equal(result.isError, false);
	assert.equal(result.structuredContent.accountId, 'alice');
	assert.equal(result.structuredContent.accountEmail, headlessStatus.accountEmail);
	assert.deepEqual(result.structuredContent.sync, headlessStatus.sync);
	assert.deepEqual(result.structuredContent.decryption, headlessStatus.decryption);
	assert.equal(seenSignal instanceof AbortSignal, true);
	b.status = async () => { throw new ServiceError('backend_request_failed'); };
	const failure = (await s.handle(call(3, 'get_status'))).result;
	assert.equal(failure.isError, true);
	assert.equal(failure.structuredContent.error.code, 'backend_request_failed');
	s.close();
});
test('get_status carries the core email through real HTTP transport into MCP structured content', async t => {
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://local');
		assert.equal(target.pathname, '/services/headless');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		assert.equal(req.method, 'POST');
		assert.deepEqual(await readJson(req), { action: 'status' });
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ ...headlessStatus, accountEmail: 'joplin.user@example.test' }));
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal('alice', 'alice');
	const s = createMcpSession(service); await ready(s);
	try {
		const result = (await s.handle(call(2, 'get_status'))).result;
		assert.equal(result.isError, false);
		assert.equal(result.structuredContent.accountEmail, 'joplin.user@example.test');
		assert.equal(result.structuredContent.accountId, 'alice');
		const tool = (await s.handle(request(3, 'tools/list'))).result.tools.find(item => item.name === 'get_status');
		assert.ok(tool.outputSchema.anyOf[0].required.includes('accountEmail'));
	} finally { s.close(); }
});
test('invalid envelopes and ids; unknown methods; no response or tool execution for notifications', async () => {
	let writes = 0; const b = backend(); b.createNote = async () => { writes++; };
	const s = session({ allowWrites: true }, b); await ready(s);
	for (const input of [null, [], 1, {}, request(null, 'ping'), request({}, 'ping'), { ...request(1, 'ping'), params: [] }]) assert.equal((await s.handle(input)).error.code, -32600);
	assert.equal((await s.handle(request(2, 'unknown'))).error.code, -32601);
	assert.deepEqual((await s.handle(request(3, 'ping'))).result, {});
	for (const method of ['tools/call', 'initialize', 'unrecognized']) assert.equal(await s.handle({ jsonrpc: '2.0', method, params: { name: 'create_note' } }), null);
	assert.equal(writes, 0);
});
test('default read-only catalog, annotations and disabled-tool enforcement', async () => {
	const s = session(); await ready(s);
	const tools = (await s.handle(request(2, 'tools/list'))).result.tools;
	assert.equal(tools.length, 18); assert.ok(tools.every(t => t.annotations.readOnlyHint));
	assert.ok(tools.some(t => t.name === 'read_note'));
	assert.ok(tools.some(t => t.name === 'list_tags'));
	assert.ok(tools.some(t => t.name === 'grep_notes'));
	for (const name of ['list_note_revisions', 'read_note_revision', 'compare_note_revisions', 'list_conflicts', 'read_conflict', 'list_note_attachments', 'read_attachment']) {
		assert.ok(tools.some(tool => tool.name === name), name);
	}
	assert.equal((await s.handle(call(3, 'create_note', { parentId: folderId, title: 'x', body: 'y' }))).error.code, -32602);
	assert.equal((await s.handle(call(4, 'delete_note', { id: noteId }))).error.code, -32602);
	assert.equal((await s.handle(request(5, 'tools/list', { cursor: 'bogus' }))).error.code, -32602);
});
test('published non-file write-tool anyOf branches contain their complete closed object schemas', async () => {
	const s = session({ allowWrites: true }); await ready(s);
	try {
		const tools = new Map((await s.handle(request(2, 'tools/list'))).result.tools.map(tool => [tool.name, tool]));
		const expected = new Map([
			['manage_tags', { required: ['note_id'], alternatives: [['add'], ['remove']] }],
			['update_notebook', { required: ['id'], alternatives: [['title'], ['parent_id']] }],
		]);

		for (const [name, { required, alternatives }] of expected) {
			const schema = tools.get(name)?.inputSchema;
			assert.ok(schema, name);
			assert.deepEqual(schema.required, required, name);
			assert.equal(schema.additionalProperties, false, name);
			assert.equal(schema.anyOf.length, alternatives.length, name);
			for (const [index, alternativeRequired] of alternatives.entries()) {
				const branch = schema.anyOf[index];
				assert.equal(branch.type, 'object', name);
				assert.deepEqual(branch.properties, schema.properties, name);
				assert.deepEqual(branch.required, [...required, ...alternativeRequired], name);
				assert.equal(branch.additionalProperties, false, name);
				for (const [propertyName, property] of Object.entries(branch.properties)) {
					assert.equal(typeof property.description, 'string', `${name}.${propertyName} description`);
					assert.ok(property.description.length > 0, `${name}.${propertyName} description`);
				}
			}
		}

		const updateAttachment = tools.get('update_attachment');
		assert.ok(updateAttachment);
		assert.deepEqual(updateAttachment.inputSchema.required, ['id']);
		assert.equal(updateAttachment.inputSchema.minProperties, 2);
		assert.equal(Object.hasOwn(updateAttachment.inputSchema, 'anyOf'), false);
		assert.ok(updateAttachment.inputSchema.properties.content_file);
		assert.deepEqual(updateAttachment._meta, { 'openai/fileParams': ['content_file'] });

		const createAttachment = tools.get('create_attachment');
		assert.deepEqual(createAttachment.inputSchema.anyOf, [
			{ required: ['content_base64'] },
			{ required: ['content_file'] },
		]);
		assert.ok(createAttachment.inputSchema.properties.content_file);
		assert.deepEqual(createAttachment._meta, { 'openai/fileParams': ['content_file'] });
	} finally { s.close(); }
});
test('semantic search publishes its full schema and reports not implemented with or without an active index', async () => {
	const schemaOf = tools => tools.find(tool => tool.name === 'semantic_search_notes')?.inputSchema;
	const assertSchema = schema => {
		assert.ok(schema);
		assert.deepEqual(Object.keys(schema.properties), ['query', 'notebook_id', 'tag_id', 'relevance']);
		assert.deepEqual(schema.required, ['query']);
		assert.deepEqual(schema.properties.relevance.enum, ['strict', 'normal', 'loose']);
		assert.equal(schema.properties.relevance.default, 'normal');
	};
	async function assertUnavailable(s) {
		await ready(s);
		const tools = (await s.handle(request(2, 'tools/list'))).result.tools;
		const schema = schemaOf(tools);
		assertSchema(schema);
		const result = await s.handle(call(3, 'semantic_search_notes', { query: 'dog sitters', tag_id: noteId, relevance: 'loose' }));
		assert.equal(result.result.isError, true);
		assert.equal(result.result.structuredContent.error.code, 'semantic_search_not_implemented');
		assert.equal(result.result.structuredContent.error.outcomeUnknown, false);
	}

	const withoutIndex = session();
	try {
		await assertUnavailable(withoutIndex);
	} finally { withoutIndex.close(); }

	const config = account();
	let semanticSearchCalls = 0;
	const withIndex = session({}, backend(), config, {
		makeSemanticBackend: () => ({
			accountId: config.id,
			status: () => ({ state: 'ready' }),
			async search() { semanticSearchCalls++; return { items: [] }; },
		}),
	});
	try {
		await ready(withIndex);
		assert.equal((await withIndex.handle(call(2, 'get_status'))).result.structuredContent.semantic.state, 'ready');
		const tools = (await withIndex.handle(request(3, 'tools/list'))).result.tools;
		assertSchema(schemaOf(tools));
		const result = await withIndex.handle(call(4, 'semantic_search_notes', { query: 'dog sitters' }));
		assert.equal(result.result.isError, true);
		assert.equal(result.result.structuredContent.error.code, 'semantic_search_not_implemented');
		assert.equal(semanticSearchCalls, 0);
	} finally { withIndex.close(); }
});
test('tool schemas reject account switching, arbitrary properties and invalid pagination before backend use', async () => {
	let invoked = 0; const b = backend(); b.getNote = async () => { invoked++; throw Error('should not call'); };
	const s = session({}, b); await ready(s);
	for (const args of [{ id: noteId, accountId: 'bob' }, { id: '../settings' }, { id: noteId, length: 0 }]) assert.equal((await s.handle(call(4, 'get_note', args))).result.isError, true);
	for (const args of [{ query: 'x', limit: 101 }, { query: '', mode: 'keyword' }, { query: 'x', page: 0 }]) assert.equal((await s.handle(call(5, 'search_notes', args))).result.isError, true);
	for (const args of [{ page: 1 }, { limit: 1 }]) assert.equal((await s.handle(call(6, 'list_notebooks', args))).result.isError, true);
	assert.equal(invoked, 0);
});
test('create_note requires an explicit notebook and accepts either destination field', async () => {
	const b = backend(); const createdInputs = [];
	const createNote = b.createNote;
	b.createNote = async input => { createdInputs.push(input); return createNote(input); };
	const config = account(); config.defaultNotebookId = 'c'.repeat(32);
	const s = session({ allowWrites: true }, b, config); await ready(s);
	try {
		const tools = (await s.handle(request(2, 'tools/list'))).result.tools;
		const schema = tools.find(tool => tool.name === 'create_note').inputSchema;
		assert.deepEqual(schema.required, ['title']);
		assert.deepEqual(schema.anyOf, [{ required: ['notebook_id'] }, { required: ['parentId'] }]);
		assert.match(schema.properties.notebook_id.description, /list_notebooks/);
		assert.match(schema.properties.parentId.description, /alias/);

		const omitted = (await s.handle(call(3, 'create_note', { title: 'No destination' }))).result;
		assert.equal(omitted.isError, true);
		assert.equal(omitted.structuredContent.error.code, 'notebook_id_required');
		assert.equal(createdInputs.length, 0, 'the configured default is not used');

		const canonical = (await s.handle(call(4, 'create_note', { title: 'Canonical', notebook_id: folderId }))).result;
		assert.equal(canonical.isError, false);
		assert.equal(createdInputs[0].parentId, folderId);
		const alias = (await s.handle(call(5, 'create_note', { title: 'Legacy alias', parentId: folderId }))).result;
		assert.equal(alias.isError, false);
		assert.equal(createdInputs[1].parentId, folderId);
	} finally { s.close(); }

	const soleBackend = backend(); let notebookScans = 0; let writes = 0;
	const listNotebooks = soleBackend.listNotebooks;
	soleBackend.listNotebooks = async (...args) => { notebookScans++; return listNotebooks(...args); };
	soleBackend.createNote = async () => { writes++; return note; };
	const onlyNotebook = session({ allowWrites: true }, soleBackend, account()); await ready(onlyNotebook);
	try {
		const omitted = (await onlyNotebook.handle(call(2, 'create_note', { title: 'No destination' }))).result;
		assert.equal(omitted.structuredContent.error.code, 'notebook_id_required');
		assert.equal(notebookScans, 0, 'the sole-readable-notebook fallback is not queried');
		assert.equal(writes, 0);
	} finally { onlyNotebook.close(); }
});
test('result identity/previews, Unicode paging and semantic fallback are explicit', async () => {
	const b = backend(); const get = b.getNote; b.getNote = async () => ({ ...await get(), body: 'A😀B'.repeat(10000) });
	const s = session({}, b); await ready(s);
	let r = (await s.handle(call(2, 'get_note', { id: noteId, length: 2 }))).result;
	assert.equal(r.structuredContent.body, 'A😀'); assert.equal(r.structuredContent.nextOffset, 3);
	assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
	r = (await s.handle(call(3, 'search_notes', { query: 'x', mode: 'hybrid' }))).result;
	assert.equal(r.structuredContent.executedMode, 'keyword'); assert.equal(r.structuredContent.semantic.state, 'unavailable');
	assert.equal(Object.hasOwn(r.structuredContent, 'items'), false);
	assert.equal(r.structuredContent.results[0].id, noteId);
	assert.equal(r.structuredContent.results[0].snippet, 'alice');
	assert.ok(!('body' in r.structuredContent.results[0]));
	r = (await s.handle(call(4, 'search_notes', { query: 'x', mode: 'semantic' }))).result;
	assert.equal(r.structuredContent.executedMode, null); assert.equal(r.structuredContent.semantic.reason, 'not_implemented');
});
test('opt-in writes also require account permission, preserve unknown outcomes and never retry', async () => {
	let calls = 0; const b = backend(); b.createNote = async () => { calls++; throw new ServiceError('write_outcome_unknown', true); };
	const config = account(); config.permissions = ['read'];
	const denied = session({ allowWrites: true }, b, config); await ready(denied);
	const args = { parentId: folderId, title: 'x', body: 'y' };
	assert.equal((await denied.handle(call(2, 'create_note', args))).result.structuredContent.error.code, 'operation_not_permitted'); assert.equal(calls, 0);
	const s = session({ allowWrites: true }, b); await ready(s);
	const result = (await s.handle(call(2, 'create_note', args))).result;
	assert.equal(result.structuredContent.error.outcomeUnknown, true); assert.equal(calls, 1);
	assert.ok(!JSON.stringify(result).includes('private-token'));
	const revision = (await s.handle(call(3, 'read_note', { id: noteId }))).result.structuredContent.revision_id;
	assert.equal((await s.handle(call(4, 'update_note', { id: noteId }))).result.structuredContent.error.code, 'invalid_tool_arguments');
	assert.equal((await s.handle(call(5, 'update_note', { id: noteId, base_revision_id: revision }))).result.structuredContent.error.code, 'invalid_tool_arguments');
});
test('write replies expose revision metadata and unexpected errors stay safe', async () => {
	const b = backend(); const s = session({ allowWrites: true }, b); await ready(s);
	const revision = (await s.handle(call(2, 'read_note', { id: noteId }))).result.structuredContent.revision_id;
	const r = (await s.handle(call(3, 'update_note', { id: noteId, base_revision_id: revision, body: 'new' }))).result;
	assert.deepEqual(Object.keys(r.structuredContent).sort(), ['changed', 'id', 'previous_revision_id', 'revision_id', 'updated_time']);
	assert.equal(Object.hasOwn(r.structuredContent, 'saved'), false);
	assert.equal(Object.hasOwn(r.structuredContent, 'synchronization'), false);
	b.getNote = async () => { throw new Error('secret upstream payload'); };
	assert.ok(!JSON.stringify(await s.handle(call(4, 'get_note', { id: noteId }))).includes('secret upstream'));
});
test('active duplicate ids, concurrency, cancellation and close reach underlying AbortSignal', async () => {
	const b = backend(); b.getNote = async (_id, signal) => { await once(signal, 'abort'); throw new ServiceError('request_cancelled'); };
	const s = session({ maxConcurrent: 1 }, b); await ready(s);
	const pending = s.handle(call('slow', 'get_note', { id: noteId }));
	assert.equal((await s.handle(call('slow', 'get_note', { id: noteId }))).error.code, -32600);
	assert.equal((await s.handle(call('other', 'get_note', { id: noteId }))).error.code, -32000);
	assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow' } }), null);
	assert.equal((await pending).result.structuredContent.error.code, 'request_cancelled');
	const more = s.handle(call(5, 'get_note', { id: noteId })); s.close(); await more;
	assert.ok((await s.handle(call(6, 'get_status'))).error);
});
test('stdio fragmented UTF-8, CRLF, multiple frames, invalid JSON and EOF', async () => {
	const input = new PassThrough(); const output = new PassThrough(); let data = '';
	output.on('data', b => { data += b; }); const t = serveStdio(session(), { input, output });
	const bytes = Buffer.from(`${JSON.stringify(initialize('2025-11-25'))}\r\n`);
	for (const byte of bytes) input.write(Buffer.from([byte]));
	input.write('{bad}\n'); input.write('[]\n');
	input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	input.write(`${JSON.stringify(call(2, 'search_notes', { query: '笔记' }))}\n`);
	await new Promise(r => setTimeout(r, 30)); input.end(); await t.done;
	const responses = data.trim().split('\n').map(JSON.parse);
	assert.ok(responses.some(r => r.error?.code === -32700)); assert.ok(responses.some(r => r.error?.code === -32600));
	assert.equal(responses.find(r => r.id === 2).result.structuredContent.accountEmail, 'alice@example.test');
});
test('stdio accepts a request larger than the former frame cap', async () => {
	const input = new PassThrough(); const output = new PassThrough(); let data = '';
	output.on('data', chunk => { data += chunk; });
	const t = serveStdio(session(), { input, output });
	const largeRequest = request(2, 'ping', { padding: 'x'.repeat(1024 * 1024) });
	const raw = `${JSON.stringify(largeRequest)}\n`;
	assert.ok(Buffer.byteLength(raw) > 1024 * 1024);
	input.write(`${JSON.stringify(initialize('2025-11-25'))}\n`);
	input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	input.write(raw);
	input.end();
	assert.equal((await t.done).failed, false);
	const responses = data.trim().split('\n').map(JSON.parse);
	assert.deepEqual(responses.find(response => response.id === 2).result, {});
});
test('stdio pending limit includes replies queued behind a stalled output write', { timeout: 10000 }, async t => {
	const input = new PassThrough();
	const outputChunks = [];
	let outputWrites = 0;
	let firstWriteCallback;
	let releaseRequested = false;
	let resolveFirstWrite;
	const firstWrite = new Promise(resolve => { resolveFirstWrite = resolve; });
	const output = new Writable({
		highWaterMark: 1,
		write(chunk, _encoding, callback) {
			outputWrites++;
			outputChunks.push(chunk.toString());
			if (outputWrites === 1) {
				firstWriteCallback = callback;
				resolveFirstWrite();
				if (releaseRequested) releaseFirstWrite();
			} else callback();
		},
	});
	let handled = 0;
	const fakeSession = {
		async handle(message) {
			handled++;
			return { jsonrpc: '2.0', id: message.id, result: {} };
		},
		close() {},
	};
	const transport = serveStdio(fakeSession, { input, output });
	function releaseFirstWrite() {
		releaseRequested = true;
		if (!firstWriteCallback) return;
		const callback = firstWriteCallback;
		firstWriteCallback = undefined;
		callback();
	}
	t.after(async () => {
		releaseFirstWrite();
		input.end();
		await transport.close();
	});
	const nextTurn = () => new Promise(resolve => setImmediate(resolve));

	for (let id = 1; id <= 64; id++) {
		input.write(`${JSON.stringify(request(id, 'ping'))}\n`);
		await nextTurn();
	}
	await firstWrite;
	assert.equal(handled, 64);
	assert.equal(outputWrites, 1);

	input.write(`${JSON.stringify(request(65, 'ping'))}\n`);
	await nextTurn();
	assert.equal(handled, 64);
	assert.equal(outputWrites, 1);

	input.end();
	releaseFirstWrite();
	assert.equal((await transport.done).failed, true);
	assert.equal(outputWrites, 65);
	const replies = outputChunks.join('').trim().split('\n').map(JSON.parse);
	assert.equal(replies.length, 65);
	assert.equal(replies.at(-1).error.code, -32000);
});
test('configuration rejects exposed token files and client-selected privilege values', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const token = path.join(dir, 'token'); const config = path.join(dir, 'mcp.json');
	fs.writeFileSync(token, 'synthetic-token', { mode: 0o600 });
	const input = { accountId: 'alice', baseUrl: 'http://127.0.0.1:41185', apiTokenFile: token };
	fs.writeFileSync(config, JSON.stringify(input)); assert.equal(loadMcpConfig(config).allowWrites, false);
	fs.chmodSync(token, 0o644); assert.throws(() => loadMcpConfig(config), /private_token_permissions_required/);
	fs.chmodSync(token, 0o600); fs.writeFileSync(config, JSON.stringify({ ...input, allowWrites: 'false' })); assert.throws(() => loadMcpConfig(config));
});
test('launched MCP process uses real HTTP, survives API failure, and does not retry a committed-but-lost response', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-process-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	let posts = 0;
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://example');
		assert.equal(target.searchParams.get('token'), 'test-token');
		if (req.method === 'POST') { await readJson(req); posts++; res.destroy(); return; }
		if (req.method === 'GET' && target.pathname === `/folders/${folderId}`) {
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ id: folderId, title: 'Notebook', parent_id: '', encryption_applied: 0, deleted_time: 0 }));
			return;
		}
		res.writeHead(503); res.end('do not leak this private response');
	});
	const token = path.join(dir, 'token'); fs.writeFileSync(token, 'test-token', { mode: 0o600 });
	const config = path.join(dir, 'mcp.json'); fs.writeFileSync(config, JSON.stringify({ accountId: 'a', baseUrl: url, apiTokenFile: token, allowWrites: true }));
	const client = new StdioTestClient(config); t.after(() => client.close());
	await client.initialize();
	const r = await client.call('create_note', { parentId: folderId, title: 'x', body: 'y' });
	assert.equal(r.structuredContent.error.code, 'write_outcome_unknown'); assert.equal(posts, 1);
	assert.equal((await client.call('get_note', { id: noteId })).isError, true);
	assert.deepEqual(await client.request('ping'), {}); assert.ok(!client.stderr.includes('private response'));
	await client.close(); assert.equal(client.child.exitCode, 0);
});
test('stdio handles malformed UTF-8, incomplete frames and tool listing', async () => {
	const input = new PassThrough(); const output = new PassThrough(); let text = ''; output.on('data', b => { text += b; });
	const t = serveStdio(session(), { input, output });
	input.write(Buffer.from([0xff, 0x0a]));
	input.write(`${JSON.stringify(initialize('2025-11-25'))}\n`);
	input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	input.write(`${JSON.stringify(request(2, 'tools/list'))}\n`);
	await new Promise(r => setTimeout(r, 20)); input.end('{'); await t.done;
	const replies = text.trim().split('\n').map(JSON.parse);
	assert.equal(replies.filter(r => r.error?.code === -32700).length, 2);
	assert.ok(replies.find(r => r.id === 2).result.tools.length > 0);
});
test('two MCP sessions with identical note ids stay bound to their own account', async () => {
	const a = session({}, backend('alice'), account('alice')); const b = session({}, backend('bob'), account('bob'));
	await ready(a); await ready(b);
	assert.equal((await a.handle(call(2, 'get_note', { id: noteId }))).result.structuredContent.body, 'alice');
	assert.equal((await b.handle(call(2, 'get_note', { id: noteId }))).result.structuredContent.body, 'bob');
});
test('stdio output failure is handled instead of an unhandled broken-pipe exception', async () => {
	const input = new PassThrough(); const output = new PassThrough(); output.on('data', () => {});
	const t = serveStdio(session(), { input, output }); output.destroy(Error('test broken pipe'));
	assert.equal((await t.done).failed, true);
});
