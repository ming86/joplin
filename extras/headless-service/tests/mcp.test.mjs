import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountRegistry, ServiceError } from '../index.mjs';
import { createMcpSession } from '../mcp.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';
import { loadMcpConfig } from '../src/mcp/config.mjs';
import { account, backend, noteId, folderId, server, readJson } from './fixtures.mjs';
import { StdioTestClient } from '../scripts/lib/stdio-client.mjs';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initialize = version => request(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
const call = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });
function session(options, customBackend = backend(), config = account()) {
	return createMcpSession(createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id), options);
}
async function ready(s) { await s.handle(initialize('2025-11-25')); await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); }

test('MCP negotiates both pinned versions; unknown version proposes supported version', async () => {
	for (const version of ['2025-11-25', '2025-06-18', '2099-01-01']) {
		const s = session(); const result = await s.handle(initialize(version));
		assert.equal(result.result.protocolVersion, version === '2099-01-01' ? '2025-11-25' : version);
		assert.deepEqual(result.result.capabilities, { tools: {} });
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
	assert.equal((await s.handle(request(2, 'tools/list'))).result.tools.length, 7);
	assert.equal((await s.handle(call(3, 'get_status'))).result.structuredContent.accountId, 'alice');
	assert.equal((await s.handle(initialize('2025-11-25'))).result.protocolVersion, '2025-11-25');
	assert.equal((await s.handle(initialize('2025-06-18'))).result.protocolVersion, '2025-06-18');
	assert.equal((await s.handle(request(4, 'initialize', {}))).error.code, -32602);
	s.close();
	assert.equal((await s.handle(request(5, 'tools/list'))).error.code, -32000);
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
	assert.equal(tools.length, 7); assert.ok(tools.every(t => t.annotations.readOnlyHint));
	assert.ok(tools.some(t => t.name === 'read_note'));
	assert.ok(tools.some(t => t.name === 'list_tags'));
	assert.equal((await s.handle(call(3, 'create_note', { parentId: folderId, title: 'x', body: 'y' }))).error.code, -32602);
	assert.equal((await s.handle(call(4, 'delete_note', { id: noteId }))).error.code, -32602);
	assert.equal((await s.handle(request(5, 'tools/list', { cursor: 'bogus' }))).error.code, -32602);
});
test('tool schemas reject account switching, arbitrary properties and invalid pagination before backend use', async () => {
	let invoked = 0; const b = backend(); b.getNote = async () => { invoked++; throw Error('should not call'); };
	const s = session({}, b); await ready(s);
	for (const args of [{ id: noteId, accountId: 'bob' }, { id: '../settings' }, { id: noteId, length: 0 }]) assert.equal((await s.handle(call(4, 'get_note', args))).result.isError, true);
	for (const args of [{ query: 'x', limit: 101 }, { query: '', mode: 'keyword' }, { query: 'x', page: 0 }]) assert.equal((await s.handle(call(5, 'search_notes', args))).result.isError, true);
	assert.equal(invoked, 0);
});
test('result identity/previews, Unicode paging and semantic fallback are explicit', async () => {
	const b = backend(); const get = b.getNote; b.getNote = async () => ({ ...await get(), body: 'A😀B'.repeat(10000) });
	const s = session({}, b); await ready(s);
	let r = (await s.handle(call(2, 'get_note', { id: noteId, length: 2 }))).result;
	assert.equal(r.structuredContent.body, 'A😀'); assert.equal(r.structuredContent.nextOffset, 3);
	assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
	r = (await s.handle(call(3, 'search_notes', { query: 'x', mode: 'hybrid' }))).result;
	assert.equal(r.structuredContent.executedMode, 'keyword'); assert.equal(r.structuredContent.semantic.state, 'unavailable');
	assert.equal(r.structuredContent.items[0].accountId, 'alice'); assert.ok(!('body' in r.structuredContent.items[0]));
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
	assert.equal((await s.handle(call(3, 'update_note', { id: noteId }))).result.structuredContent.error.code, 'empty_note_update');
});
test('local-save semantics and safe unexpected error output', async () => {
	const b = backend(); const s = session({ allowWrites: true }, b); await ready(s);
	const r = (await s.handle(call(2, 'update_note', { id: noteId, body: 'new' }))).result;
	assert.equal(r.structuredContent.saved, 'local'); assert.equal(r.structuredContent.synchronization, 'not_confirmed');
	b.getNote = async () => { throw new Error('secret upstream payload'); };
	assert.ok(!JSON.stringify(await s.handle(call(3, 'get_note', { id: noteId }))).includes('secret upstream'));
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
	assert.equal(responses.find(r => r.id === 2).result.structuredContent.accountId, 'alice');
});
test('stdio oversized frames fail with bounded output', async () => {
	const input = new PassThrough(); const output = new PassThrough(); let size = 0; output.on('data', b => { size += b.length; });
	const t = serveStdio(session(), { input, output, maxFrameBytes: 32 }); input.write('x'.repeat(33));
	assert.equal((await t.done).failed, true); assert.ok(size < 200);
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
test('stdio handles malformed UTF-8, incomplete frame and bounded oversized tool output', async () => {
	const input = new PassThrough(); const output = new PassThrough(); let text = ''; output.on('data', b => { text += b; });
	const t = serveStdio(session(), { input, output, maxOutputBytes: 512 });
	input.write(Buffer.from([0xff, 0x0a]));
	input.write(`${JSON.stringify(initialize('2025-11-25'))}\n`);
	input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	input.write(`${JSON.stringify(request(2, 'tools/list'))}\n`);
	await new Promise(r => setTimeout(r, 20)); input.end('{'); await t.done;
	const replies = text.trim().split('\n').map(JSON.parse);
	assert.equal(replies.filter(r => r.error?.code === -32700).length, 2);
	assert.equal(replies.find(r => r.id === 2).result.structuredContent.error.code, 'tool_response_too_large');
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
