import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpSession } from '../src/mcp/session.mjs';

const accountId = 'alice';
const noteId = 'a'.repeat(32);
const conflictId = 'b'.repeat(32);
const fromRevisionId = 'c'.repeat(32);
const toRevisionId = 'd'.repeat(32);
const body = 'A historical body with emoji 🧰 and café.\n';

/** Confirm an output has exactly the keys required by one closed output-mode variant. */
function assertDeclaredVariant(schema, value, label) {
	const keys = Object.keys(value).sort();
	const variant = schema.oneOf?.find(branch => Object.keys(branch.properties ?? {}).sort().join('\0') === keys.join('\0'));
	assert.ok(variant, `${label} has the keys of one declared output variant`);
	assert.equal(variant.additionalProperties, false, `${label} variant is closed`);
	assert.deepEqual(variant.required, Object.keys(variant.properties), `${label} variant requires every field`);
}

/** Build a session whose native reads return stable revision and conflict records. */
function createFixtureSession() {
	const conflictNote = {
		id: conflictId,
		parent_id: 'e'.repeat(32),
		title: 'Conflict copy',
		body,
		created_time: 1,
		updated_time: 2,
		is_todo: 0,
		todo_completed: 0,
		markup_language: 1,
		is_conflict: 1,
		conflict_original_id: noteId,
	};
	const service = {
		async status() { return { accountId, accountEmail: 'alice@example.test' }; },
		async readNoteRevision() {
			return {
				note_id: noteId,
				revision_id: fromRevisionId,
				captured_time: 10,
				title: 'Historical title',
				body,
				metadata: { markup_language: 1, is_todo: 0 },
				accountId,
			};
		},
		async compareNoteRevisions() {
			return {
				accountId,
				note_id: noteId,
				from_revision_id: fromRevisionId,
				to_revision_id: toRevisionId,
				to_current: false,
				from_body_total_line_count: 2,
				to_body_total_line_count: 4,
				title_diff: 'title patch',
				body_diff: 'body patch',
				metadata_changes: [],
			};
		},
		async readConflict() {
			return {
				accountId,
				conflict: { id: conflictId, status: 'available', note: conflictNote },
				original: { id: noteId, status: 'locked' },
			};
		},
	};
	return createMcpSession(service, { stateless: true });
}

/** Return a tool's structured output through the real MCP session path. */
async function callTool(session, id, name, args) {
	const response = await session.handle({
		jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
	});
	assert.equal(response.result.isError, false, `${name} returns a successful result`);
	return response.result;
}

test('revision and conflict mode schemas match real inline, file, and metadata results', async t => {
	const session = createFixtureSession();
	t.after(() => session.close());
	const toolsResponse = await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
	const schemas = new Map(toolsResponse.result.tools.map(tool => [tool.name, tool.outputSchema.anyOf[0]]));
	const noteIdArgs = { note_id: noteId, revision_id: fromRevisionId };
	const revisionSchema = schemas.get('read_note_revision');
	assert.equal(revisionSchema.oneOf.length, 3);
	for (const variant of revisionSchema.oneOf) {
		assert.equal(variant.type, 'object');
		assert.equal(variant.additionalProperties, false);
		assert.ok(variant.description);
		assert.deepEqual(variant.required, Object.keys(variant.properties));
	}

	const inlineRevision = (await callTool(session, 2, 'read_note_revision', noteIdArgs)).structuredContent;
	assertDeclaredVariant(revisionSchema, inlineRevision, 'inline revision');
	assert.equal(inlineRevision.body, body);
	assert.equal(inlineRevision.body_total_line_count, 2);
	const fileRevisionResult = await callTool(session, 3, 'read_note_revision', { ...noteIdArgs, output: 'file' });
	const fileRevision = fileRevisionResult.structuredContent;
	assertDeclaredVariant(revisionSchema, fileRevision, 'file revision');
	assert.equal(Object.hasOwn(fileRevision, 'body'), false);
	assert.equal(fileRevision.body_total_line_count, 2);
	assert.equal(Object.hasOwn(fileRevision, 'body_offset'), false);
	assert.equal(fileRevisionResult.content[1].resource.uri, fileRevision.file.uri);
	const metadataRevision = (await callTool(session, 4, 'read_note_revision', { ...noteIdArgs, output: 'metadata' })).structuredContent;
	assertDeclaredVariant(revisionSchema, metadataRevision, 'metadata revision');
	assert.equal(metadataRevision.body_length, body.length);
	assert.equal(metadataRevision.body_total_line_count, 2);
	assert.equal(metadataRevision.body_size_bytes, Buffer.byteLength(body, 'utf8'));
	assert.equal(Object.hasOwn(metadataRevision, 'body'), false);
	assert.equal(Object.hasOwn(metadataRevision, 'file'), false);
	assert.equal(revisionSchema.oneOf.some(variant => Object.keys(variant.properties).sort().join('\0') === Object.keys({ ...fileRevision, body }).sort().join('\0')), false, 'file mode rejects an inline body');
	assert.equal(revisionSchema.oneOf.some(variant => Object.keys(variant.properties).sort().join('\0') === Object.keys({ ...metadataRevision, file: fileRevision.file }).sort().join('\0')), false, 'metadata mode rejects a file descriptor');

	const compareSchema = schemas.get('compare_note_revisions');
	assert.equal(compareSchema.oneOf.length, 2);
	const compareArgs = { note_id: noteId, from_revision_id: fromRevisionId, to_revision_id: toRevisionId };
	const inlineComparison = (await callTool(session, 5, 'compare_note_revisions', compareArgs)).structuredContent;
	assertDeclaredVariant(compareSchema, inlineComparison, 'inline comparison');
	assert.equal(inlineComparison.title_diff, 'title patch');
	assert.equal(inlineComparison.from_body_total_line_count, 2);
	assert.equal(inlineComparison.to_body_total_line_count, 4);
	const fileComparisonResult = await callTool(session, 6, 'compare_note_revisions', { ...compareArgs, output: 'file' });
	const fileComparison = fileComparisonResult.structuredContent;
	assertDeclaredVariant(compareSchema, fileComparison, 'file comparison');
	assert.equal(Object.hasOwn(fileComparison, 'title_diff'), false);
	assert.equal(Object.hasOwn(fileComparison, 'body_diff'), false);
	assert.equal(fileComparison.from_body_total_line_count, 2);
	assert.equal(fileComparison.to_body_total_line_count, 4);
	assert.equal(fileComparison.metadata_changes.length, 0);
	assert.equal(fileComparisonResult.content[1].resource.uri, fileComparison.file.uri);
	assert.equal(compareSchema.oneOf.some(variant => Object.keys(variant.properties).sort().join('\0') === Object.keys({ ...fileComparison, title_diff: 'unexpected inline diff' }).sort().join('\0')), false, 'file comparison rejects inline diffs');

	const conflictSchema = schemas.get('read_conflict');
	const conflictArgs = { id: conflictId };
	for (const [index, output] of ['inline', 'file', 'metadata'].entries()) {
		const result = await callTool(session, 7 + index, 'read_conflict', { ...conflictArgs, output });
		assert.deepEqual(result.structuredContent.original, { id: noteId, status: 'locked' }, 'unavailable original retains its existing status shape');
		const conflictNoteOutput = result.structuredContent.conflict.note;
		const availableConflictSchema = conflictSchema.properties.conflict.oneOf.find(branch => branch.properties.status.const === 'available');
		assertDeclaredVariant(availableConflictSchema.properties.note, conflictNoteOutput, `${output} conflict note`);
		assert.equal(conflictNoteOutput.body_total_line_count, 2);
		if (output === 'inline') assert.equal(conflictNoteOutput.body, body);
		if (output === 'file') {
			assert.equal(Object.hasOwn(conflictNoteOutput, 'body'), false);
			assert.equal(Object.hasOwn(conflictNoteOutput, 'body_offset'), false);
			assert.equal(result.content.some(item => item.type === 'resource' && item.resource.uri === conflictNoteOutput.file.uri), true);
			const mutated = {
				...result.structuredContent,
				conflict: { ...result.structuredContent.conflict, note: { ...conflictNoteOutput, body } },
			};
			assert.equal(availableConflictSchema.properties.note.oneOf.some(variant => Object.keys(variant.properties).sort().join('\0') === Object.keys(mutated.conflict.note).sort().join('\0')), false, 'file conflict side rejects an inline body');
		}
		if (output === 'metadata') {
			assert.equal(conflictNoteOutput.body_length, body.length);
			assert.equal(Object.hasOwn(conflictNoteOutput, 'body'), false);
			assert.equal(Object.hasOwn(conflictNoteOutput, 'file'), false);
		}
	}

	const fileDescriptor = revisionSchema.oneOf.find(variant => Object.hasOwn(variant.properties, 'file')).properties.file;
	assert.equal(fileDescriptor.properties.size.type, 'integer');
	assert.equal(fileDescriptor.properties.size.minimum, 0);
	assert.equal(fileDescriptor.properties.sha256.pattern, '^[a-f0-9]{64}$');
	assert.equal(fileDescriptor.properties.expires_at.format, 'date-time');
	const bodyMeasures = revisionSchema.oneOf.find(variant => Object.hasOwn(variant.properties, 'body_sha256'));
	assert.equal(bodyMeasures.properties.body_length.type, 'integer');
	assert.equal(bodyMeasures.properties.body_size_bytes.type, 'integer');
	assert.equal(bodyMeasures.properties.body_sha256.pattern, '^[a-f0-9]{64}$');
});
