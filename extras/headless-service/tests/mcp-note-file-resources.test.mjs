import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createAccountRegistry } from '../index.mjs';
import { createMcpSession } from '../src/mcp/session.mjs';
import { startMcpHttpServer } from '../src/mcp/http.mjs';
import { createNoteFileResources } from '../src/mcp/note-file-resources.mjs';
import { account, backend, folderId, initialRevisionId, note, noteId } from './fixtures.mjs';

const version = '2026-07-28';
const versionKey = 'io.modelcontextprotocol/protocolVersion';
const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
const token = 'note-file-http-test-token';

/** Provide native rich note fields from one stable read snapshot. */
function nativeNote(overrides = {}) {
	return {
		id: '0123456789abcdef0123456789abcdef',
		title: '  ../Week: résumé?  ',
		body: 'First line\n\n📝 café\n',
		revision_id: 'revision-1',
		markup_language: 1,
		...overrides,
	};
}

/** Build a modern request with the required per-request metadata. */
function modernRequest(id, method, params = {}) {
	return {
		jsonrpc: '2.0', id, method,
		params: { _meta: { [versionKey]: version, [capabilitiesKey]: {} }, ...params },
	};
}

/** Send one authenticated or unauthenticated modern HTTP request with its routing headers. */
function post(server, message, { authenticated = true } = {}) {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
		'MCP-Protocol-Version': version,
		'Mcp-Method': message.method,
		...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
		...(message.method === 'tools/call' ? { 'Mcp-Name': message.params.name } : {}),
		...(message.method === 'resources/read' ? { 'Mcp-Name': message.params.uri } : {}),
	};
	return new Promise((resolve, reject) => {
		const req = http.request(`${server.baseUrl}/mcp`, { method: 'POST', agent: false, headers }, res => {
			const parts = [];
			res.on('data', part => parts.push(part));
			res.on('error', reject);
			res.on('end', () => {
				const text = Buffer.concat(parts).toString();
				resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : undefined });
			});
		});
		req.on('error', reject);
		req.end(JSON.stringify(message));
	});
}

test('note exports preserve exact UTF-8 bytes and return stable metadata without exposing paths', () => {
	const store = createNoteFileResources();
	try {
		const body = nativeNote().body;
		const { file, resource } = store.exportNote(nativeNote());
		const bytes = Buffer.from(body, 'utf8');
		assert.match(file.uri, /^joplin-note-file:\/\/[0-9a-f-]{36}\//);
		assert.equal(file.filename, 'Week résumé-89abcdef.md');
		assert.equal(file.mime_type, 'text/markdown; charset=utf-8');
		assert.equal(file.size, bytes.length);
		assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
		assert.equal(new Date(file.expires_at).toISOString(), file.expires_at);
		assert.deepEqual(resource, {
			uri: file.uri,
			mimeType: file.mime_type,
			blob: bytes.toString('base64'),
		});
		assert.deepEqual(store.read(file.uri), { contents: [resource] });
		assert.deepEqual(store.list(), [{ name: file.filename, mimeType: file.mime_type, size: file.size, uri: file.uri }]);
		assert.equal(Object.hasOwn(store.list()[0], 'blob'), false);

		const html = store.exportNote(nativeNote({ markup_language: 2 }));
		assert.match(html.file.filename, /\.html$/);
		assert.equal(html.file.mime_type, 'text/html; charset=utf-8');

		const supplementaryTitle = store.exportNote(nativeNote({ title: `${'x'.repeat(99)}😀` }));
		assert.match(supplementaryTitle.file.filename, /😀-89abcdef\.md$/);
		assert.equal(decodeURIComponent(supplementaryTitle.file.uri.split('/').at(-1)), supplementaryTitle.file.filename);
	} finally {
		store.close();
	}
});

test('note file store removes expired and closed exports and rejects incomplete snapshots', () => {
	let time = 10_000;
	const store = createNoteFileResources({ now: () => time, lifetimeMs: 500 });
	const { file } = store.exportNote(nativeNote());
	assert.equal(store.list().length, 1);
	time += 499;
	assert.equal(store.list().length, 1);
	time += 1;
	assert.deepEqual(store.list(), []);
	assert.throws(() => store.read(file.uri), error => error.code === 'note_file_unavailable');
	assert.throws(() => store.exportNote(nativeNote({ revision_id: undefined })), error => error.code === 'invalid_note_input');
	store.close();
	assert.throws(() => store.read(file.uri), error => error.code === 'note_file_unavailable');
});

test('MCP resource methods preserve protocol envelopes and shared HTTP-style stores across session close', async () => {
	const store = createNoteFileResources();
	const { file } = store.exportNote(nativeNote());
	const session = createMcpSession({}, { stateless: true, noteFileResources: store });
	try {
		const listed = await session.handle(modernRequest(1, 'resources/list'));
		assert.deepEqual(listed.result.resources, [{ name: file.filename, mimeType: file.mime_type, size: file.size, uri: file.uri }]);
		assert.equal(listed.result.resultType, 'complete');
		assert.equal(listed.result.ttlMs, 0);

		const read = await session.handle(modernRequest(2, 'resources/read', { uri: file.uri }));
		assert.equal(read.result.resultType, 'complete');
		assert.equal(read.result.contents[0].uri, file.uri);
		assert.equal(Buffer.from(read.result.contents[0].blob, 'base64').toString('utf8'), nativeNote().body);

		const unknownUri = 'joplin-note-file://private-export/token';
		const unavailable = await session.handle(modernRequest(3, 'resources/read', { uri: unknownUri }));
		assert.equal(unavailable.error.code, -32002);
		assert.equal(unavailable.error.message.includes(unknownUri), false);

		const legacyList = await session.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} });
		assert.equal(legacyList.result.resultType, undefined);
		assert.equal(legacyList.result.resources.length, 1);
		assert.equal((await session.handle(modernRequest(5, 'resources/list', { cursor: 'next' }))).error.code, -32602);
		assert.equal((await session.handle(modernRequest(6, 'resources/read', { uri: 1 }))).error.code, -32602);
	} finally {
		session.close();
	}

	// Closing a transient stateless HTTP-style session must not erase its server's shared store.
	assert.equal(store.read(file.uri).contents.length, 1);
	store.close();
});

test('HTTP exports a note file that a separate authenticated POST can read', async t => {
	const body = 'First line\r\n\n📝 café — exact UTF-8 bytes\n';
	const customBackend = backend();
	customBackend.getNote = async () => ({
		...note,
		parent_id: folderId,
		title: 'Review résumé ✨',
		body,
		markup_language: 2,
	});
	const config = account();
	const service = createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id);
	const server = await startMcpHttpServer({ service, bearerToken: token });
	t.after(() => server.close());

	const exported = await post(server, modernRequest(1, 'tools/call', {
		name: 'read_note', arguments: { id: noteId, output: 'file' },
	}));
	assert.equal(exported.status, 200);
	assert.equal(exported.json.result.resultType, 'complete');
	const metadata = exported.json.result.structuredContent;
	const file = metadata.file;
	assert.equal(metadata.id, noteId);
	assert.equal(metadata.title, 'Review résumé ✨');
	assert.equal(metadata.accountEmail, 'alice@example.test');
	assert.equal(metadata.revision_id, initialRevisionId);
	assert.equal(metadata.notebook_id, folderId);
	assert.equal(metadata.notebook_title, 'alice');
	assert.deepEqual(metadata.tags, []);
	assert.equal(metadata.markup_language, 2);
	assert.equal(Object.hasOwn(metadata, 'body'), false);
	assert.equal(file.mime_type, 'text/html; charset=utf-8');
	assert.match(file.filename, /Review résumé ✨-[a-f0-9]{8}\.html$/);
	assert.equal(file.size, Buffer.byteLength(body, 'utf8'));
	assert.equal(file.sha256, createHash('sha256').update(body, 'utf8').digest('hex'));
	const embedded = exported.json.result.content.find(block => block.type === 'resource').resource;
	assert.equal(embedded.uri, file.uri);
	assert.equal(Buffer.from(embedded.blob, 'base64').toString('utf8'), body);

	const read = await post(server, modernRequest(2, 'resources/read', { uri: file.uri }));
	assert.equal(read.status, 200);
	assert.equal(read.json.result.resultType, 'complete');
	assert.deepEqual(read.json.result.contents, [{
		uri: file.uri,
		mimeType: file.mime_type,
		blob: Buffer.from(body, 'utf8').toString('base64'),
	}]);

	const unauthorized = await post(server, modernRequest(3, 'resources/read', { uri: file.uri }), { authenticated: false });
	assert.equal(unauthorized.status, 401);
	assert.deepEqual(unauthorized.json, { error: 'unauthorized' });
});
