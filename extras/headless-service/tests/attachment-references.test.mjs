import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../src/errors.mjs';
import { createAttachmentReferenceClient } from '../src/attachment-reference-client.mjs';
import { createAttachmentReferenceService } from '../src/attachment-references.mjs';
import { registerAttachmentReferenceTools } from '../src/mcp/attachment-reference-tools.mjs';
import { attachmentReferenceOutputSchemas } from '../src/mcp/attachment-reference-output-schemas.mjs';

const attachmentId = 'a'.repeat(32);
const firstNoteId = 'b'.repeat(32);
const secondNoteId = 'c'.repeat(32);

const reference = (id, fields = {}) => ({
	id,
	title: 'Current note',
	parent_id: 'd'.repeat(32),
	created_time: 10,
	updated_time: 20,
	deleted_time: 0,
	is_conflict: 0,
	...fields,
});

test('attachment-reference client uses one fixed read-only action with normalized pagination', async () => {
	const calls = [];
	const responses = [
		{ attachment_id: attachmentId, items: [reference(firstNoteId)], hasMore: true },
		{ attachment_id: attachmentId, items: [reference(secondNoteId)], hasMore: false },
	];
	const client = createAttachmentReferenceClient(async (...args) => { calls.push(args); return responses.shift(); });
	const signal = new AbortController().signal;
	assert.deepEqual(await client.listAttachmentNotes({ id: attachmentId, page: 2, limit: 3 }, signal), {
		attachment_id: attachmentId,
		items: [reference(firstNoteId)],
		hasMore: true,
	});
	assert.deepEqual(await client.listAttachmentNotes({ id: attachmentId }), {
		attachment_id: attachmentId,
		items: [reference(secondNoteId)],
		hasMore: false,
	});
	assert.deepEqual(calls.map(call => call[3]), [
		{ action: 'listAttachmentNotes', id: attachmentId, page: 2, limit: 3 },
		{ action: 'listAttachmentNotes', id: attachmentId, page: 1, limit: 20 },
	]);
	assert.ok(calls.every(call => call[0] === 'services/headless' && call[1] && call[2] === 'POST'
		&& call[5].writeOperation === false));
	assert.equal(calls[0][4], signal);

	await assert.rejects(client.listAttachmentNotes({ id: 'invalid' }), { code: 'invalid_attachment_reference_input' });
	await assert.rejects(client.listAttachmentNotes({ id: attachmentId, extra: true }), { code: 'invalid_attachment_reference_input' });
	await assert.rejects(client.listAttachmentNotes({ id: attachmentId, page: 0 }), { code: 'invalid_attachment_reference_input' });
	await assert.rejects(client.listAttachmentNotes({ id: attachmentId, limit: 101 }), { code: 'invalid_attachment_reference_input' });
});

test('attachment-reference client returns only allowlisted native note metadata', async () => {
	const nativeRow = {
		...reference(firstNoteId, { title: 'In Trash', deleted_time: 100, is_conflict: 1 }),
		body: 'current note body',
		backendOnly: 'must not escape',
	};
	const client = createAttachmentReferenceClient(async () => ({
		attachment_id: attachmentId,
		items: [nativeRow],
		hasMore: false,
		backendOnly: 'must not escape',
	}));
	assert.deepEqual(await client.listAttachmentNotes({ id: attachmentId }), {
		attachment_id: attachmentId,
		items: [reference(firstNoteId, { title: 'In Trash', deleted_time: 100, is_conflict: 1 })],
		hasMore: false,
	});
	assert.equal((await client.listAttachmentNotes({ id: attachmentId })).items[0].body, undefined);
});

test('attachment-reference client maps only the known unapplied native error and rejects malformed results', async () => {
	const invalid = createAttachmentReferenceClient(async () => ({
		error: { code: 'invalid_attachment_reference_input', message: 'private backend detail', applied: false },
	}));
	await assert.rejects(invalid.listAttachmentNotes({ id: attachmentId }), error => {
		assert.equal(error.code, 'invalid_attachment_reference_input');
		assert.equal(error.outcomeUnknown, false);
		assert.equal(error.message, 'The attachment reference request is invalid.');
		return true;
	});
	for (const response of [
		{ error: { code: 'invalid_attachment_reference_input', message: 'x', applied: true } },
		{ attachment_id: secondNoteId, items: [], hasMore: false },
		{ attachment_id: attachmentId, items: [{ ...reference(firstNoteId), is_conflict: true }], hasMore: false },
	]) {
		const client = createAttachmentReferenceClient(async () => response);
		await assert.rejects(client.listAttachmentNotes({ id: attachmentId }), { code: 'invalid_backend_response' });
	}
});

test('attachment-reference service checks read permission and forwards account-bound pagination', async () => {
	const calls = [];
	const permissions = [];
	const backend = {
		async listAttachmentNotes(input, signal) {
			calls.push([input, signal]);
			return { attachment_id: attachmentId, items: [reference(firstNoteId)], hasMore: true };
		},
	};
	const service = createAttachmentReferenceService({
		backend: () => backend,
		permit(permission) { permissions.push(permission); },
		accountId: 'alice',
	});
	const signal = new AbortController().signal;
	assert.deepEqual(await service.listAttachmentNotes({ id: attachmentId, page: 4, limit: 7 }, signal), {
		accountId: 'alice', attachment_id: attachmentId, items: [reference(firstNoteId)], hasMore: true,
	});
	assert.deepEqual(calls, [[{ id: attachmentId, page: 4, limit: 7 }, signal]]);
	assert.deepEqual(permissions, ['read']);
	await assert.rejects(service.listAttachmentNotes({ id: attachmentId, limit: 101 }), { code: 'invalid_attachment_reference_input' });

	let backendCalls = 0;
	const denied = createAttachmentReferenceService({
		backend: () => ({ async listAttachmentNotes() { backendCalls++; return {}; } }),
		permit() { throw new ServiceError('operation_not_permitted'); },
		accountId: 'alice',
	});
	await assert.rejects(denied.listAttachmentNotes({ id: attachmentId }), { code: 'operation_not_permitted' });
	assert.equal(backendCalls, 0);
});

test('list_attachment_notes registers read-only metadata output with explicit reference scope', async () => {
	let definition;
	const referenceToolService = {
		async listAttachmentNotes(input, signal) { return { accountId: 'alice', attachment_id: attachmentId, items: [], hasMore: false, input, signal }; },
	};
	registerAttachmentReferenceTools((name, description, inputSchema, run, annotations) => {
		definition = { name, description, inputSchema, run, annotations };
	}, referenceToolService);

	assert.equal(definition.name, 'list_attachment_notes');
	assert.equal(definition.annotations.readOnlyHint, true);
	assert.equal(definition.annotations.destructiveHint, false);
	assert.equal(definition.inputSchema.additionalProperties, false);
	assert.deepEqual(definition.inputSchema.required, ['id']);
	assert.match(definition.description, /current saved bodies/);
	assert.match(definition.description, /attachment-reference index/);
	assert.match(definition.description, /deleted_time/);
	assert.match(definition.description, /is_conflict/);
	assert.match(definition.description, /encrypted or locked notes are omitted/);

	const signal = new AbortController().signal;
	assert.deepEqual(await definition.run({ id: attachmentId, page: 3 }, signal), {
		accountId: 'alice', attachment_id: attachmentId, items: [], hasMore: false,
		input: { id: attachmentId, page: 3, limit: 20 }, signal,
	});
	const schema = attachmentReferenceOutputSchemas.list_attachment_notes;
	assert.deepEqual(schema.required, ['attachment_id', 'accountEmail', 'items', 'hasMore']);
	assert.deepEqual(schema.properties.accountEmail.type, ['string', 'null']);
	assert.deepEqual(schema.properties.items.items.properties.is_conflict.enum, [0, 1]);
});
