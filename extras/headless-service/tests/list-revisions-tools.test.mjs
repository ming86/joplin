import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '../src/errors.mjs';
import { createMcpSession } from '../mcp.mjs';

const noteId = 'a'.repeat(32);
const notebookId = 'b'.repeat(32);
const revisionId = 'c'.repeat(32);
const accountId = 'local-binding';
const accountEmail = 'reader@example.test';

/** Make a list_revisions MCP session that records the service boundary calls. */
function sessionWithRevisionService({ listRevisions } = {}) {
	const calls = [];
	const service = {
		async status() { return { accountId, accountEmail }; },
		async listRevisions(input, signal) {
			calls.push({ input, signal });
			return listRevisions ? listRevisions(input) : {
				accountId,
				items: [{
					note_id: noteId,
					revision_id: revisionId,
					parent_revision_id: null,
					captured_time: 1700000000000,
					current_title: null,
					current_notebook_id: notebookId,
				}],
				page: input.page,
				limit: input.limit,
				hasMore: false,
			};
		},
		async listNoteRevisions(input) {
			return { accountId, items: [], hasMore: false };
		},
	};
	return { session: createMcpSession(service, { stateless: true }), calls };
}

test('list_revisions publishes the read-only selector, timestamp, pagination, and output contracts', async () => {
	const { session, calls } = sessionWithRevisionService();
	try {
		const listed = await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const tools = new Map(listed.result.tools.map(tool => [tool.name, tool]));
		const definition = tools.get('list_revisions');
		assert.ok(definition);
		assert.deepEqual(definition.annotations, {
			readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
		});
		assert.equal(definition.inputSchema.additionalProperties, false);
		assert.deepEqual(definition.inputSchema.required, []);

		const input = definition.inputSchema.properties;
		assert.deepEqual(input.note_ids.items.pattern, '^[a-f0-9]{32}$');
		assert.deepEqual(input.notebook_ids.items.pattern, '^[a-f0-9]{32}$');
		assert.equal(input.include_descendants.default, true);
		assert.equal(input.page.minimum, 1);
		assert.equal(input.page.maximum, Number.MAX_SAFE_INTEGER);
		assert.equal(input.page.default, 1);
		assert.equal(input.limit.minimum, 1);
		assert.equal(input.limit.maximum, Number.MAX_SAFE_INTEGER);
		assert.equal(input.limit.default, 20);
		assert.equal(input.since.minimum, Number.MIN_SAFE_INTEGER);
		assert.equal(input.until.maximum, Number.MAX_SAFE_INTEGER);
		assert.match(input.since.description, /Inclusive lower bound/);
		assert.match(input.until.description, /Exclusive upper bound/);
		assert.match(definition.description, /deduplicated union/);
		assert.match(definition.description, /empty selector contributes no notes/);
		assert.match(definition.description, /current descendants/);
		assert.match(definition.description, /does not reconstruct past notebook membership/);
		assert.match(definition.description, /not collection, synchronization, or first-observed time/);
		assert.match(definition.description, /without reading bodies or capturing a new snapshot/);
		assert.match(definition.description, /live view/);
		assert.match(definition.description, /read_note_revision/);
		assert.match(definition.description, /compare_note_revisions/);
		assert.match(definition.description, /read_note/);
		assert.match(definition.description, /current revision_id/);
		assert.match(definition.description, /update_note/);

		const oldHistoryLimit = tools.get('list_note_revisions').inputSchema.properties.limit;
		assert.equal(oldHistoryLimit.maximum, 100);
		assert.equal(oldHistoryLimit.default, 20);

		const called = await session.handle({
			jsonrpc: '2.0', id: 2, method: 'tools/call',
			params: { name: 'list_revisions', arguments: {} },
		});
		assert.equal(called.result.isError, false);
		assert.deepEqual(calls[0].input, { include_descendants: true, page: 1, limit: 20 });
		assert.ok(calls[0].signal instanceof AbortSignal);

		const response = called.result.structuredContent;
		assert.deepEqual(Object.keys(response).sort(), ['accountEmail', 'hasMore', 'items', 'limit', 'page']);
		assert.equal(response.accountEmail, accountEmail);
		assert.equal(Object.hasOwn(response, 'accountId'), false);
		assert.deepEqual(Object.keys(response.items[0]).sort(), [
			'captured_time', 'current_notebook_id', 'current_title', 'note_id', 'parent_revision_id', 'revision_id',
		]);
		assert.equal(response.items[0].current_title, null);
		assert.equal(Object.hasOwn(response.items[0], 'accountId'), false);
		assert.equal(Object.hasOwn(response.items[0], 'body'), false);

		const output = definition.outputSchema.anyOf[0];
		assert.equal(output.additionalProperties, false);
		assert.deepEqual(output.required, ['accountEmail', 'items', 'page', 'limit', 'hasMore']);
		assert.deepEqual(Object.keys(response).sort(), Object.keys(output.properties).sort());
		assert.equal(output.properties.items.items.additionalProperties, false);
		assert.deepEqual(Object.keys(response.items[0]).sort(), Object.keys(output.properties.items.items.properties).sort());
		assert.deepEqual(output.properties.items.items.properties.current_title.type, ['string', 'null']);
		assert.deepEqual(output.properties.items.items.properties.current_notebook_id.type, ['string', 'null']);
		assert.match(output.properties.items.items.properties.captured_time.description, /item_updated_time/);
		assert.match(output.properties.items.items.properties.captured_time.description, /may be adjusted to preserve parent order/);
		assert.match(output.properties.items.items.properties.captured_time.description, /not collection, synchronization, or first-observed time/);
	} finally {
		session.close();
	}
});

test('list_revisions forwards selectors, signed time bounds, defaults, and uncapped safe pagination', async () => {
	const { session, calls } = sessionWithRevisionService();
	try {
		const response = await session.handle({
			jsonrpc: '2.0', id: 1, method: 'tools/call',
			params: {
				name: 'list_revisions',
				arguments: {
				note_ids: [], notebook_ids: [], include_descendants: false,
				since: -10, until: -10, page: 1_000_001, limit: 101,
				},
			},
		});
		assert.equal(response.result.isError, false);
		assert.deepEqual(calls[0].input, {
			note_ids: [], notebook_ids: [], include_descendants: false,
			since: -10, until: -10, page: 1_000_001, limit: 101,
		});
		assert.ok(calls[0].signal instanceof AbortSignal);

		const badIds = await session.handle({
			jsonrpc: '2.0', id: 2, method: 'tools/call',
			params: { name: 'list_revisions', arguments: { note_ids: ['not-a-native-id'] } },
		});
		assert.equal(badIds.result.isError, true);
		assert.equal(badIds.result.structuredContent.error.code, 'invalid_tool_arguments');
		assert.equal(calls.length, 1);
	} finally {
		session.close();
	}
});

test('list_revisions returns a fixed safe detail for native revision errors', async () => {
	const { session } = sessionWithRevisionService({
		listRevisions() { throw new ServiceError('revision_invalid_request', false, 'private native diagnostic'); },
	});
	const originalError = console.error;
	console.error = () => {};
	try {
		const response = await session.handle({
			jsonrpc: '2.0', id: 1, method: 'tools/call',
			params: { name: 'list_revisions', arguments: {} },
		});
		assert.equal(response.result.isError, true);
		assert.deepEqual(response.result.structuredContent.error, {
			code: 'revision_invalid_request', message: 'The revision request is invalid.', outcomeUnknown: false,
		});
		assert.ok(!JSON.stringify(response.result.structuredContent).includes('private native diagnostic'));
	} finally {
		console.error = originalError;
		session.close();
	}
});
