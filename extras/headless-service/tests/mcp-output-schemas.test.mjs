import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../index.mjs';
import { createMcpSession } from '../mcp.mjs';

const accountId = 'alice';
const noteId = 'a'.repeat(32);
const notebookId = 'b'.repeat(32);
const revisionId = 'c'.repeat(32);
const tagId = 'd'.repeat(32);
const resourceId = 'e'.repeat(32);
const conflictId = 'f'.repeat(32);
const note = {
	id: noteId, accountId, parent_id: notebookId, title: 'A note', body: 'Body 🔧',
	created_time: 1, updated_time: 2, is_todo: 1, todo_completed: 0,
	markup_language: 1, encryption_applied: 0, deleted_time: 0, is_locked: 0,
};
const attachment = {
	id: resourceId, accountId, filename: 'diagram.png', title: 'Diagram', mime: 'image/png',
	file_extension: 'png', size: 2, created_time: 1, updated_time: 2,
	encryption_applied: 0, encryption_blob_encrypted: 0, is_locked: 0,
};

const sampleArguments = {
	get_status: {},
	list_notebooks: {},
	list_tags: {},
	list_notes: {},
	search_notes: { query: 'Body', mode: 'keyword' },
	semantic_search_notes: { query: 'meaning' },
	read_note: { id: noteId },
	get_note: { id: noteId },
	create_note: { title: 'Created', notebook_id: notebookId },
	update_note: { id: noteId, base_revision_id: revisionId, body: 'Updated' },
	delete_note: { id: noteId },
	create_notebook: { title: 'Nested', parent_id: notebookId },
	manage_tags: { note_id: noteId, add: ['idea'] },
	list_note_revisions: { note_id: noteId },
	read_note_revision: { note_id: noteId, revision_id: revisionId },
	compare_note_revisions: { note_id: noteId, from_revision_id: revisionId },
	list_conflicts: {},
	read_conflict: { id: conflictId },
	update_notebook: { id: notebookId, title: 'Renamed' },
	delete_notebook: { id: notebookId },
	create_tag: { title: 'idea' },
	rename_tag: { id: tagId, title: 'inspiration' },
	list_note_attachments: { note_id: noteId },
	read_attachment: { id: resourceId },
	create_attachment: { filename: 'new.bin', content_base64: 'AQI=' },
	update_attachment: { id: resourceId, title: 'Updated diagram' },
};

/** Return native attachment metadata, including bytes only for attachment reads. */
function attachmentResult(contentBase64) {
	return { ...attachment, ...(contentBase64 === undefined ? {} : { contentBase64 }) };
}

/** Build the same MCP runner used by both protocol versions around a fixed service fixture. */
export function createOutputSchemaTestSession({ allowWrites = true } = {}) {
	const service = {
		async status() {
			return {
				accountId, accountEmail: 'alice@example.test', semantic: { state: 'unavailable', reason: 'not_implemented' },
				observedAt: 3, serviceStartedAt: 1,
				sync: { running: false, pending: false, report: null },
				decryption: { state: 'idle', batch: null, missingMasterKey: false, disabledItemCount: 0 },
			};
		},
		async listAllNotebooks() {
			return { accountId, notebooks: [{ id: notebookId, title: 'Notes', parent_id: null, note_count: 1 }] };
		},
		async listTags() { return { tags: [{ id: tagId, title: 'idea' }] }; },
		async listNotes() { return { items: [note], hasMore: false }; },
		async search() {
			return {
				accountId, requestedMode: 'keyword', executedMode: 'keyword',
				semantic: { state: 'unavailable', reason: 'not_implemented' },
				items: [{ ...note, provenance: 'keyword' }], hasMore: false, total: 1,
			};
		},
		async readNoteWithRevision(id) {
			if (id === 'f'.repeat(32)) throw new ServiceError('note_unavailable');
			return { ...note, revision_id: revisionId, previous_revision_id: null, changed: false };
		},
		async updateNoteWithRevision() {
			return { ...note, updated_time: 4, revision_id: '1'.repeat(32), previous_revision_id: revisionId, changed: true };
		},
		async createNote() { return { ...note, id: '2'.repeat(32), title: 'Created' }; },
		async deleteNote() { return { id: noteId }; },
		async createNotebook() { return { id: '3'.repeat(32), title: 'Nested', parent_id: notebookId }; },
		async manageTags() { return { note_id: noteId, added: ['idea'], removed: [], tags: ['idea'] }; },
		async listNoteRevisions() {
			return { accountId, items: [{ revision_id: revisionId, captured_time: 10, parent_revision_id: null, accountId }], hasMore: false };
		},
		async readNoteRevision() {
			return { note_id: noteId, revision_id: revisionId, captured_time: 10, title: 'Earlier', body: 'Old body', metadata: { is_todo: 1, labels: ['work', null] }, accountId };
		},
		async compareNoteRevisions() {
			return {
				accountId, note_id: noteId, from_revision_id: revisionId, to_revision_id: '1'.repeat(32),
				to_current: true, title_diff: '', body_diff: '',
				metadata_changes: [
					{ field: 'is_todo', from: { present: true, value: 1 }, to: { present: false } },
				],
			};
		},
		async listConflicts() {
			return { accountId, items: [{ id: conflictId, title: 'Conflict', conflict_original_id: noteId, created_time: 1, updated_time: 2 }], hasMore: false };
		},
		async readConflict() {
			return {
				accountId,
				conflict: {
					id: conflictId, status: 'available', note: {
						id: conflictId, parent_id: notebookId, title: 'A conflict', body: 'Body 🔧',
						created_time: 1, updated_time: 2, is_todo: 1, todo_completed: 0,
						markup_language: 1, is_conflict: 1, conflict_original_id: noteId,
					},
				},
				original: { id: noteId, status: 'locked' },
			};
		},
		async updateNotebook() { return { id: notebookId, title: 'Renamed', parent_id: null, accountId }; },
		async deleteNotebook() { return { id: notebookId, trashed: true, accountId }; },
		async createTag() { return { id: tagId, title: 'idea', accountId }; },
		async renameTag() { return { id: tagId, title: 'inspiration', accountId }; },
		async listNoteAttachments() { return [attachmentResult()]; },
		async readAttachment() { return attachmentResult('AQI='); },
		async createAttachment() { return { ...attachmentResult(), id: '4'.repeat(32) }; },
		async updateAttachment() { return { ...attachment, title: 'Updated diagram' }; },
	};
	return createMcpSession(service, { allowWrites, stateless: true });
}

/** Call one sample for each catalog tool through the actual session and runner. */
export async function callOutputSchemaSamples(session) {
	const tools = (await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
	const byName = new Map(tools.map(tool => [tool.name, tool]));
	const results = new Map();
	let requestId = 2;
	for (const [name, args] of Object.entries(sampleArguments)) {
		if (!byName.has(name)) continue;
		const response = await session.handle({
			jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name, arguments: args },
		});
		results.set(name, response.result);
	}
	const errorSamples = new Map();
	for (const [label, args] of [
		['read_note_unavailable', { id: 'f'.repeat(32) }],
		['read_note_invalid_arguments', { id: noteId, extra: true }],
	]) {
		const response = await session.handle({
			jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name: 'read_note', arguments: args },
		});
		errorSamples.set(label, response.result);
	}
	return { tools, results, errorSamples };
}

test('every enabled catalog tool publishes an output schema without changing input schemas or annotations', async () => {
	const readonlySession = createOutputSchemaTestSession({ allowWrites: false });
	const writableSession = createOutputSchemaTestSession({ allowWrites: true });
	try {
		const readonly = await callOutputSchemaSamples(readonlySession);
		const writable = await callOutputSchemaSamples(writableSession);
		assert.equal(readonly.tools.length, 15);
		assert.equal(writable.tools.length, 26);
		const writableByName = new Map(writable.tools.map(tool => [tool.name, tool]));
		for (const tool of writable.tools) {
			assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
			assert.deepEqual(tool.outputSchema.type, 'object');
			assert.equal(tool.outputSchema.anyOf?.length, 2, `${tool.name} documents success and structured errors`);
			const [success, errors] = tool.outputSchema.anyOf;
			assert.equal(success.type, 'object', `${tool.name} success schema is an object`);
			assert.ok(Object.keys(success.properties ?? {}).length > 0, `${tool.name} success schema has fields`);
			assert.ok(success.required?.length > 0, `${tool.name} success schema requires fields`);
			assert.deepEqual(errors.required, ['error']);
			assert.deepEqual(errors.properties.error.required, ['code']);
		}
		for (const tool of readonly.tools) {
			const counterpart = writableByName.get(tool.name);
			assert.deepEqual(counterpart.inputSchema, tool.inputSchema, `${tool.name} input schema is unchanged`);
			assert.deepEqual(counterpart.annotations, tool.annotations, `${tool.name} annotations are unchanged`);
			assert.deepEqual(counterpart.outputSchema, tool.outputSchema, `${tool.name} output is protocol-era independent`);
		}
		assert.equal(readonly.results.size, 15);
		assert.equal(writable.results.size, 26);
	} finally {
		readonlySession.close();
		writableSession.close();
	}
});

test('tool output samples preserve aliases, nullable history, semantic errors, and attachment resource bytes', async () => {
	const session = createOutputSchemaTestSession();
	try {
		const { tools, results, errorSamples } = await callOutputSchemaSamples(session);
		const schemas = new Map(tools.map(tool => [tool.name, tool.outputSchema.anyOf[0]]));
		const status = results.get('get_status').structuredContent;
		assert.equal(status.accountEmail, 'alice@example.test');
		assert.equal(status.accountId, accountId);
		assert.deepEqual(schemas.get('get_status').properties.accountEmail.type, ['string', 'null']);
		assert.ok(schemas.get('get_status').required.includes('accountEmail'));
		const modernRead = results.get('read_note').structuredContent;
		const legacyRead = results.get('get_note').structuredContent;
		assert.equal(typeof modernRead.is_todo, 'boolean');
		assert.equal(typeof modernRead.todo_completed, 'boolean');
		assert.equal(typeof legacyRead.is_todo, 'number');
		assert.equal(typeof legacyRead.todo_completed, 'number');
		assert.equal(schemas.get('read_note').properties.is_todo.type, 'boolean');
		assert.equal(schemas.get('get_note').properties.is_todo.type, 'number');
		assert.deepEqual(schemas.get('read_note').properties.nextOffset.type, ['number', 'null']);

		const revisionList = results.get('list_note_revisions').structuredContent;
		assert.equal(revisionList.items[0].parent_revision_id, null);
		const revisionSchema = schemas.get('list_note_revisions').properties.items.items.properties.parent_revision_id;
		assert.deepEqual(revisionSchema.anyOf.map(item => item.type).sort(), ['null', 'string']);
		const comparison = results.get('compare_note_revisions').structuredContent;
		assert.equal(comparison.to_current, true);
		assert.equal(comparison.metadata_changes[0].from.present, true);
		assert.equal(comparison.metadata_changes[0].to.present, false);
		const metadataChange = schemas.get('compare_note_revisions').properties.metadata_changes.items.properties.from;
		assert.equal(metadataChange.oneOf.length, 2);

		const conflict = results.get('read_conflict').structuredContent;
		assert.equal(conflict.conflict.status, 'available');
		assert.equal(conflict.original.status, 'locked');
		assert.equal(Object.hasOwn(conflict.original, 'note'), false);
		assert.equal(schemas.get('read_conflict').properties.original.oneOf.some(side => side.properties.status.const === 'locked'), true);

		const unavailable = results.get('semantic_search_notes');
		assert.equal(unavailable.isError, true);
		assert.equal(unavailable.structuredContent.error.code, 'semantic_search_not_implemented');
		assert.equal(errorSamples.get('read_note_unavailable').isError, true);
		assert.equal(errorSamples.get('read_note_unavailable').structuredContent.error.code, 'note_unavailable');
		assert.equal(errorSamples.get('read_note_invalid_arguments').isError, true);
		assert.equal(errorSamples.get('read_note_invalid_arguments').structuredContent.error.code, 'invalid_tool_arguments');

		const readAttachment = results.get('read_attachment');
		assert.equal(readAttachment.isError, false);
		assert.equal(readAttachment.structuredContent.filename, 'diagram.png');
		assert.equal(Object.hasOwn(readAttachment.structuredContent, 'contentBase64'), false);
		assert.equal(schemas.get('read_attachment').properties.contentBase64, undefined);
		assert.deepEqual(readAttachment.content[1], {
			type: 'resource',
			resource: { uri: `joplin-resource://${resourceId}/diagram.png`, mimeType: 'image/png', blob: 'AQI=' },
		});
	} finally {
		session.close();
	}
});
