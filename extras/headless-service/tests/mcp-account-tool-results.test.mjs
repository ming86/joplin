import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/mcp/tools.mjs';
import { createNoteFileResources } from '../src/mcp/note-file-resources.mjs';
import { isMcpToolResult } from '../src/mcp/attachment-tools.mjs';

const noteId = 'a'.repeat(32);
const revisionId = 'b'.repeat(32);
const accountId = 'local-profile-binding';
const accountEmail = 'signed-in@example.test';
const note = { id: noteId, accountId, title: 'Example', body: 'Exact 🔧\r\n', revision_id: revisionId, updated_time: 10 };

/** Build the real tool catalog around service results carrying the local account binding. */
function fixture(overrides = {}, options = {}) {
	let statusReads = 0;
	const service = {
		async status() { statusReads++; return { accountId, accountEmail }; },
		async readNoteWithRevision() { return { ...note }; },
		async listNotes() { return { accountId, items: [{ ...note }], page: 1, hasMore: false }; },
		async search() { return { accountId, items: [{ ...note }] }; },
		async listNoteRevisions() { return { accountId, items: [{ accountId, id: revisionId }], hasMore: false }; },
		async listRevisions() {
			return {
				accountId,
				items: [{
					note_id: noteId,
					revision_id: revisionId,
					parent_revision_id: null,
					captured_time: 10,
					current_title: note.title,
					current_notebook_id: null,
				}],
				page: 1,
				limit: 20,
				hasMore: false,
			};
		},
		async readNoteRevision() { return { ...note, metadata: { accountId: 'native-field' } }; },
		async compareNoteRevisions() { return { accountId, metadata_changes: { accountId: 'native-field' } }; },
		async readAttachment() { return { accountId, id: noteId, filename: 'sample.bin', mime: 'application/octet-stream', contentBase64: 'AP8=' }; },
		async updateNoteWithRevision() { return { ...note, previous_revision_id: revisionId, changed: false }; },
		...overrides,
	};
	return { tools: createTools(service, options), statusReads: () => statusReads };
}

/** Assert the public JSON text describes exactly the structured result. */
function assertMatchingContent(result) {
	assert.equal(result.isError, false);
	assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
	return result.structuredContent;
}

/** Assert an identity-bearing record exposes only its authenticated profile email. */
function assertEmail(record) {
	assert.equal(Object.hasOwn(record, 'accountId'), false);
	assert.equal(record.accountEmail, accountEmail);
}

test('note, search, list and revision tools serialize projected account identities', async () => {
	const { tools, statusReads } = fixture();
	for (const name of ['read_note', 'get_note']) {
		const value = assertMatchingContent(await tools.call(name, { id: noteId }));
		assertEmail(value);
		assert.equal(value.body, note.body);
	}
	const list = assertMatchingContent(await tools.call('list_notes'));
	assertEmail(list);
	assertEmail(list.items[0]);
	const listSchema = tools.list().find(tool => tool.name === 'list_notes').outputSchema.anyOf[0];
	assert.deepEqual(listSchema.properties.accountEmail.type, ['string', 'null']);
	assert.equal(listSchema.required.includes('accountEmail'), false);
	assert.equal(Object.hasOwn(listSchema.properties, 'accountId'), false);
	const search = assertMatchingContent(await tools.call('search_notes', { query: 'Example' }));
	assertEmail(search);
	assert.equal(search.results[0].id, noteId);
	const revisions = assertMatchingContent(await tools.call('list_note_revisions', { note_id: noteId }));
	assertEmail(revisions);
	assertEmail(revisions.items[0]);
	const accountRevisions = assertMatchingContent(await tools.call('list_revisions', { note_ids: [noteId] }));
	assertEmail(accountRevisions);
	assert.equal(accountRevisions.items[0].current_title, note.title);
	assert.equal(Object.hasOwn(accountRevisions.items[0], 'accountEmail'), false);
	const revision = assertMatchingContent(await tools.call('read_note_revision', { note_id: noteId, revision_id: revisionId }));
	assertEmail(revision);
	assert.deepEqual(revision.metadata, { accountId: 'native-field' });
	const comparison = assertMatchingContent(await tools.call('compare_note_revisions', { note_id: noteId, from_revision_id: revisionId }));
	assertEmail(comparison);
	assert.deepEqual(comparison.metadata_changes, { accountId: 'native-field' });
	assert.equal(statusReads(), 1);
});

test('list_notes preserves optional page attribution and satisfies the advertised schema in both layouts', async () => {
	for (const attributed of [false, true]) {
		const { tools } = fixture({
			async listNotes() {
				return { ...(attributed ? { accountId } : {}), items: [{ ...note }], hasMore: true };
			},
		});
		const result = assertMatchingContent(await tools.call('list_notes'));
		assert.equal(Object.hasOwn(result, 'accountId'), false);
		assert.equal(Object.hasOwn(result, 'accountEmail'), attributed);
		if (attributed) assertEmail(result);
		assertEmail(result.items[0]);
		const schema = tools.list().find(tool => tool.name === 'list_notes').outputSchema.anyOf[0];
		// Check the actual page and row contracts: required fields and every returned field's type.
		for (const [record, contract] of [[result, schema], [result.items[0], schema.properties.items.items]]) {
			for (const key of contract.required) assert.ok(Object.hasOwn(record, key), key);
			for (const [key, value] of Object.entries(record)) {
				const rule = contract.properties[key];
				if (!rule) {
					assert.notEqual(contract.additionalProperties, false, key);
					continue;
				}
				const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
				assert.ok([rule.type].flat().includes(type), key);
			}
		}
	}
});

test('note file exports project metadata before embedding the exact UTF-8 body', async t => {
	const store = createNoteFileResources();
	t.after(() => store.close());
	const { tools } = fixture({}, { noteFileResources: store });
	for (const name of ['read_note', 'get_note']) {
		const result = await tools.call(name, { id: noteId, output: 'file' });
		const value = assertMatchingContent(result);
		assertEmail(value);
		assert.equal(isMcpToolResult(result), true);
		assert.equal(Object.hasOwn(value, 'body'), false);
		assert.equal(result.content.length, 2);
		assert.equal(Buffer.from(result.content[1].resource.blob, 'base64').toString('utf8'), note.body);
		assert.deepEqual(store.read(value.file.uri).contents, [result.content[1].resource]);
		assert.equal(result.content[0].text.includes(accountId), false);
	}
});

test('native attachment results retain their marker and binary resource after account projection', async () => {
	const { tools } = fixture();
	const result = await tools.call('read_attachment', { id: noteId });
	assertEmail(assertMatchingContent(result));
	assert.equal(isMcpToolResult(result), true);
	assert.deepEqual(result.content[1], {
		type: 'resource',
		resource: { uri: `joplin-resource://${noteId}/sample.bin`, mimeType: 'application/octet-stream', blob: 'AP8=' },
	});
	assert.equal(Object.hasOwn(result.structuredContent, 'contentBase64'), false);
});

test('status retains its diagnostic binding and compact update acknowledgments stay compact', async () => {
	const { tools } = fixture({}, { allowWrites: true });
	const status = assertMatchingContent(await tools.call('get_status'));
	assert.deepEqual(status, { accountId, accountEmail });
	const acknowledgment = assertMatchingContent(await tools.call('update_note', { id: noteId, base_revision_id: revisionId, title: 'Changed' }));
	assert.deepEqual(acknowledgment, { id: noteId, updated_time: 10, revision_id: revisionId, previous_revision_id: revisionId, changed: false });
});

test('unavailable authenticated email remains null without failing a note read', async () => {
	const { tools } = fixture({ async status() { return null; } });
	const value = assertMatchingContent(await tools.call('read_note', { id: noteId }));
	assert.equal(Object.hasOwn(value, 'accountId'), false);
	assert.equal(value.accountEmail, null);
});
