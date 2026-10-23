import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ServiceError } from '../src/errors.mjs';
import { isMcpToolResult } from '../src/mcp/attachment-tools.mjs';
import { createNoteFileResources } from '../src/mcp/note-file-resources.mjs';
import { registerRevisionTools } from '../src/mcp/revision-tools.mjs';

const noteId = 'a'.repeat(32);
const fromRevisionId = 'b'.repeat(32);
const toRevisionId = 'c'.repeat(32);

/** Register history tools with a shared export store and return their direct runners. */
function fixture(service, store) {
	const definitions = new Map();
	registerRevisionTools((name, description, inputSchema, run, annotations) => {
		definitions.set(name, { description, inputSchema, run, annotations });
	}, service, { getFileResources: () => store });
	return definitions;
}

test('read_note_revision metadata output measures the exact historical UTF-8 body without returning it', async () => {
	const body = 'A😀 — café\n';
	let reads = 0;
	const revision = {
		note_id: noteId,
		revision_id: fromRevisionId,
		captured_time: 123,
		title: 'A history note',
		body,
		metadata: { markup_language: 1, is_todo: 1 },
		accountId: 'alice',
	};
	const tools = fixture({
		async readNoteRevision(input) {
			reads++;
			assert.deepEqual(input, { note_id: noteId, revision_id: fromRevisionId });
			return revision;
		},
	}, createNoteFileResources());
	const definition = tools.get('read_note_revision');
	assert.deepEqual(definition.inputSchema.properties.output.enum, ['inline', 'file', 'metadata']);
	assert.equal(definition.inputSchema.properties.output.default, 'inline');

	const result = await definition.run({ note_id: noteId, revision_id: fromRevisionId, output: 'metadata' });
	assert.deepEqual(result, {
		note_id: noteId,
		revision_id: fromRevisionId,
		captured_time: 123,
		title: 'A history note',
		metadata: { markup_language: 1, is_todo: 1 },
		accountId: 'alice',
		body_length: body.length,
		body_size_bytes: Buffer.byteLength(body, 'utf8'),
		body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
		body_total_line_count: 2,
	});
	for (const field of ['body', 'offset', 'body_offset', 'body_returned_chars', 'has_more', 'nextOffset', 'totalLength', 'offsetUnit']) {
		assert.equal(Object.hasOwn(result, field), false, field);
	}
	assert.equal(reads, 1);
});

test('read_note_revision file output embeds exact historical bytes and preserves revision metadata after live deletion', async t => {
	const body = '## Résumé 📝\r\n\nline two — exact bytes\n';
	const store = createNoteFileResources();
	t.after(() => store.close());
	let reads = 0;
	const revision = {
		note_id: noteId,
		revision_id: fromRevisionId,
		captured_time: 123,
		title: 'Historical résumé',
		body,
		metadata: { markup_language: 2, parent_id: 'd'.repeat(32) },
		accountId: 'alice',
	};
	// The service exposes only immutable history here; no live note lookup can occur after deletion.
	const tools = fixture({
		async readNoteRevision() { reads++; return revision; },
	}, store);
	const result = await tools.get('read_note_revision').run({ note_id: noteId, revision_id: fromRevisionId, output: 'file' });
	assert.equal(isMcpToolResult(result), true);
	assert.equal(result.content.length, 2);
	const metadata = result.structuredContent;
	assert.equal(Object.hasOwn(metadata, 'body'), false);
	assert.equal(metadata.note_id, noteId);
	assert.equal(metadata.revision_id, fromRevisionId);
	assert.equal(metadata.captured_time, 123);
	assert.equal(metadata.title, 'Historical résumé');
	assert.deepEqual(metadata.metadata, revision.metadata);
	assert.equal(metadata.body_total_line_count, 4);
	assert.equal(metadata.accountId, 'alice');
	assert.equal(metadata.file.filename, `note-${noteId}-revision-${fromRevisionId}.html`);
	assert.equal(metadata.file.mime_type, 'text/html; charset=utf-8');
	const textMetadata = JSON.parse(result.content[0].text);
	assert.equal(Object.hasOwn(textMetadata, 'body'), false);
	assert.equal(textMetadata.body_total_line_count, 4);
	const resource = result.content[1].resource;
	const bytes = Buffer.from(resource.blob, 'base64');
	assert.equal(resource.uri, metadata.file.uri);
	assert.equal(resource.mimeType, metadata.file.mime_type);
	assert.deepEqual(bytes, Buffer.from(body, 'utf8'));
	assert.equal(metadata.file.size, bytes.length);
	assert.equal(metadata.file.sha256, createHash('sha256').update(bytes).digest('hex'));
	assert.deepEqual(store.read(metadata.file.uri).contents, [resource]);
	assert.equal(reads, 1);
});

test('read_note_revision rejects file and metadata slicing before reading native history', async () => {
	let reads = 0;
	const tools = fixture({
		async readNoteRevision() { reads++; return { body: 'body' }; },
	}, createNoteFileResources());
	const run = tools.get('read_note_revision').run;
	for (const output of ['file', 'metadata']) {
		for (const selector of ['offset', 'max_chars']) {
			await assert.rejects(run({ note_id: noteId, revision_id: fromRevisionId, output, [selector]: 0 }), error => {
				assert.ok(error instanceof ServiceError);
				assert.equal(error.code, 'note_file_slice_conflict');
				return true;
			});
		}
	}
	assert.equal(reads, 0);
});

test('compare_note_revisions file output stores both exact diffs and keeps only metadata inline', async t => {
	const titleDiff = '--- old\n+++新\n@@ -1 +1 @@\n-Old café\n+New 東京\n';
	const bodyDiff = '@@ -1,2 +1,2 @@\n-ancien 🐈\n+nouveau 🐈‍⬛\n';
	const comparison = {
		note_id: noteId,
		from_revision_id: fromRevisionId,
		to_revision_id: toRevisionId,
		to_current: false,
		from_body_total_line_count: 3,
		to_body_total_line_count: 5,
		title_diff: titleDiff,
		body_diff: bodyDiff,
		metadata_changes: [{ field: 'parent_id', from: { present: true, value: 'd'.repeat(32) }, to: { present: false } }],
		accountId: 'alice',
	};
	const store = createNoteFileResources();
	t.after(() => store.close());
	let comparisons = 0;
	const tools = fixture({
		async compareNoteRevisions(input) {
			comparisons++;
			assert.deepEqual(input, { note_id: noteId, from_revision_id: fromRevisionId, to_revision_id: toRevisionId });
			return comparison;
		},
	}, store);
	const definition = tools.get('compare_note_revisions');
	assert.deepEqual(definition.inputSchema.properties.output.enum, ['inline', 'file']);
	assert.equal(definition.inputSchema.properties.output.default, 'inline');

	const result = await definition.run({ note_id: noteId, from_revision_id: fromRevisionId, to_revision_id: toRevisionId, output: 'file' });
	assert.equal(isMcpToolResult(result), true);
	const metadata = result.structuredContent;
	assert.equal(Object.hasOwn(metadata, 'title_diff'), false);
	assert.equal(Object.hasOwn(metadata, 'body_diff'), false);
	assert.deepEqual({
		note_id: metadata.note_id,
		from_revision_id: metadata.from_revision_id,
		to_revision_id: metadata.to_revision_id,
		to_current: metadata.to_current,
		from_body_total_line_count: metadata.from_body_total_line_count,
		to_body_total_line_count: metadata.to_body_total_line_count,
		metadata_changes: metadata.metadata_changes,
		accountId: metadata.accountId,
	}, {
		note_id: noteId,
		from_revision_id: fromRevisionId,
		to_revision_id: toRevisionId,
		to_current: false,
		from_body_total_line_count: 3,
		to_body_total_line_count: 5,
		metadata_changes: comparison.metadata_changes,
		accountId: 'alice',
	});
	const textMetadata = JSON.parse(result.content[0].text);
	assert.equal(Object.hasOwn(textMetadata, 'title_diff'), false);
	assert.equal(Object.hasOwn(textMetadata, 'body_diff'), false);
	const resource = result.content[1].resource;
	const bytes = Buffer.from(resource.blob, 'base64');
	const expectedDiff = `=== title diff ===\n${titleDiff}\n\n=== body diff ===\n${bodyDiff}`;
	assert.deepEqual(bytes, Buffer.from(expectedDiff, 'utf8'));
	assert.equal(resource.mimeType, 'text/x-diff; charset=utf-8');
	assert.equal(metadata.file.mime_type, 'text/x-diff; charset=utf-8');
	assert.equal(metadata.file.filename, `note-${noteId}-revisions-${fromRevisionId}-${toRevisionId}.diff`);
	assert.equal(metadata.file.size, bytes.length);
	assert.equal(metadata.file.sha256, createHash('sha256').update(bytes).digest('hex'));
	assert.deepEqual(store.read(metadata.file.uri).contents, [resource]);
	assert.equal(comparisons, 1);
});

test('inline revision reads retain UTF-16 chunks and inline comparisons retain both diff strings', async () => {
	const tools = fixture({
		async readNoteRevision() { return { note_id: noteId, revision_id: fromRevisionId, body: 'x😀yz\r\n' }; },
		async compareNoteRevisions() { return { title_diff: 'title', body_diff: 'body', metadata_changes: [] }; },
	}, createNoteFileResources());
	const chunk = await tools.get('read_note_revision').run({ note_id: noteId, revision_id: fromRevisionId, offset: 2, max_chars: 1 });
	assert.equal(chunk.body, '😀');
	assert.equal(chunk.body_total_line_count, 2);
	assert.equal(chunk.body_offset, 1);
	assert.equal(chunk.nextOffset, 3);
	assert.equal(chunk.has_more, true);
	const comparison = await tools.get('compare_note_revisions').run({ note_id: noteId, from_revision_id: fromRevisionId });
	assert.deepEqual(comparison, { title_diff: 'title', body_diff: 'body', metadata_changes: [] });
});
