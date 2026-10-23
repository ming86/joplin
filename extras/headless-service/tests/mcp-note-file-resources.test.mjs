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
	assert.equal(metadata.body_total_line_count, 4);
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

test('HTTP revision, comparison, and conflict exports share one readable file store', async t => {
	const revisionId = '1'.repeat(32);
	const nextRevisionId = '2'.repeat(32);
	const conflictId = '3'.repeat(32);
	const revisionBody = 'Historical résumé 📝\r\nsecond line\n';
	const titleDiff = '--- old\n+++ new 東京\n';
	const bodyDiff = '@@ -1 +1 @@\n-ancien 🐈\n+nouveau 🐈‍⬛\n';
	const conflictBody = 'Conflict copy: café — local\n';
	const originalBody = 'Original note: 東京 — synced\r\n';
	const expectedDiff = `=== title diff ===\n${titleDiff}\n\n=== body diff ===\n${bodyDiff}`;
	const service = {
		async status() { return { accountEmail: 'alice@example.test' }; },
		async readNoteRevision(input) {
			assert.deepEqual(input, { note_id: noteId, revision_id: revisionId });
			return {
				note_id: noteId,
				revision_id: revisionId,
				captured_time: 123,
				title: 'Historical résumé',
				body: revisionBody,
				metadata: { markup_language: 1, parent_id: folderId },
				accountId: 'alice',
			};
		},
		async compareNoteRevisions(input) {
			assert.deepEqual(input, {
				note_id: noteId,
				from_revision_id: revisionId,
				to_revision_id: nextRevisionId,
			});
			return {
				note_id: noteId,
				from_revision_id: revisionId,
				to_revision_id: nextRevisionId,
				to_current: false,
				from_body_total_line_count: 3,
				to_body_total_line_count: 4,
				title_diff: titleDiff,
				body_diff: bodyDiff,
				metadata_changes: [{ field: 'parent_id', from: { present: true, value: folderId }, to: { present: false } }],
				accountId: 'alice',
			};
		},
		async readConflict(input) {
			assert.deepEqual(input, { id: conflictId });
			return {
				accountId: 'alice',
				conflict: {
					id: conflictId,
					status: 'available',
					note: {
						id: conflictId,
						title: 'Conflict copy',
						body: conflictBody,
						markup_language: 1,
					},
				},
				original: {
					id: noteId,
					status: 'available',
					note: {
						id: noteId,
						title: 'Original note',
						body: originalBody,
						markup_language: 2,
					},
				},
			};
		},
	};
	const server = await startMcpHttpServer({ service, bearerToken: token });
	t.after(() => server.close());

	async function callTool(id, name, args) {
		const response = await post(server, modernRequest(id, 'tools/call', { name, arguments: args }));
		assert.equal(response.status, 200);
		assert.equal(response.json.result.resultType, 'complete');
		const result = response.json.result;
		const metadata = result.structuredContent;
		assert.equal(metadata.accountEmail, 'alice@example.test');
		assert.equal(Object.hasOwn(metadata, 'accountId'), false);
		assert.deepEqual(JSON.parse(result.content[0].text), metadata);
		return metadata;
	}

	const revision = await callTool(1, 'read_note_revision', {
		note_id: noteId, revision_id: revisionId, output: 'file',
	});
	assert.equal(revision.revision_id, revisionId);
	assert.equal(revision.body_total_line_count, 3);
	assert.equal(Object.hasOwn(revision, 'body'), false);

	const comparison = await callTool(2, 'compare_note_revisions', {
		note_id: noteId, from_revision_id: revisionId, to_revision_id: nextRevisionId, output: 'file',
	});
	assert.equal(comparison.from_revision_id, revisionId);
	assert.equal(comparison.to_revision_id, nextRevisionId);
	assert.equal(comparison.from_body_total_line_count, 3);
	assert.equal(comparison.to_body_total_line_count, 4);
	assert.equal(Object.hasOwn(comparison, 'title_diff'), false);
	assert.equal(Object.hasOwn(comparison, 'body_diff'), false);

	const conflict = await callTool(3, 'read_conflict', { id: conflictId, output: 'file' });
	assert.equal(conflict.conflict.status, 'available');
	assert.equal(conflict.original.status, 'available');
	assert.equal(Object.hasOwn(conflict.conflict.note, 'body'), false);
	assert.equal(Object.hasOwn(conflict.original.note, 'body'), false);
	assert.equal(conflict.conflict.note.body_total_line_count, 2);
	assert.equal(conflict.original.note.body_total_line_count, 2);

	const exports = [
		{ file: revision.file, bytes: Buffer.from(revisionBody, 'utf8') },
		{ file: comparison.file, bytes: Buffer.from(expectedDiff, 'utf8') },
		{ file: conflict.conflict.note.file, bytes: Buffer.from(conflictBody, 'utf8') },
		{ file: conflict.original.note.file, bytes: Buffer.from(originalBody, 'utf8') },
	];
	for (const [index, entry] of exports.entries()) {
		const read = await post(server, modernRequest(4 + index, 'resources/read', { uri: entry.file.uri }));
		assert.equal(read.status, 200);
		assert.equal(read.json.result.resultType, 'complete');
		assert.deepEqual(read.json.result.contents, [{
			uri: entry.file.uri,
			mimeType: entry.file.mime_type,
			blob: entry.bytes.toString('base64'),
		}]);
	}

	const listed = await post(server, modernRequest(8, 'resources/list'));
	assert.equal(listed.status, 200);
	assert.equal(listed.json.result.resultType, 'complete');
	assert.equal(listed.json.result.resources.length, 4);
	assert.deepEqual(listed.json.result.resources, exports.map(({ file, bytes }) => ({
		name: file.filename,
		mimeType: file.mime_type,
		size: bytes.length,
		uri: file.uri,
	})));
});
