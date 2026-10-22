import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentService } from '../src/attachments.mjs';
import { isMcpToolResult, registerAttachmentTools } from '../src/mcp/attachment-tools.mjs';
import { ServiceError } from '../src/errors.mjs';

const noteId = 'a'.repeat(32);
const resourceId = 'b'.repeat(32);
const accountId = 'alice';
const note = { id: noteId, encryption_applied: 0, deleted_time: 0, is_locked: 0 };
const metadata = {
	id: resourceId,
	title: 'diagram',
	mime: 'image/png',
	file_extension: 'png',
	size: 4,
	created_time: 10,
	updated_time: 11,
	encryption_applied: 0,
	encryption_blob_encrypted: 0,
	is_locked: 0,
};

function fakeBackend(overrides = {}) {
	return {
		async getNote() { return { ...note }; },
		async listNoteAttachments() { return [{ ...metadata, backendOnly: 'hidden' }]; },
		async getAttachment() { return { ...metadata }; },
		async readAttachment() { return { ...metadata, filename: 'diagram.png', contentBase64: 'AAECAw==' }; },
		async createAttachment(input) { return { ...metadata, id: 'c'.repeat(32), savedInput: input }; },
		async updateAttachment(_id, input) { return { ...metadata, updatedInput: input }; },
		...overrides,
	};
}

const bindBackend = value => () => value;

function makeTools(service, allowWrites = false) {
	const tools = new Map();
	const add = (name, description, inputSchema, run, annotations) => tools.set(name, { description, inputSchema, run, annotations });
	registerAttachmentTools(add, service, { allowWrites });
	return tools;
}

test('attachment service checks read permission, note eligibility, and returns allowlisted metadata', async () => {
	const calls = [];
	const service = createAttachmentService({
		backend: bindBackend(fakeBackend()),
		permit(permission) { calls.push(permission); },
		accountId,
	});
	const attachments = await service.listNoteAttachments(noteId);
	assert.deepEqual(calls, ['read']);
	assert.deepEqual(attachments, [{ ...metadata, accountId }]);

	let listed = false;
	const encrypted = createAttachmentService({
		backend: bindBackend(fakeBackend({
			async getNote() { return { ...note, encryption_applied: 1 }; },
			async listNoteAttachments() { listed = true; return []; },
		})),
		permit() {},
		accountId,
	});
	await assert.rejects(encrypted.listNoteAttachments(noteId), error => error.code === 'note_unavailable');
	assert.equal(listed, false, 'ineligible note does not reach its attachment endpoint');
});

test('attachment service enforces permissions before backend calls and blocks encrypted or locked resources', async () => {
	let backendCalls = 0;
	const backend = fakeBackend({
		async getAttachment() { backendCalls++; return { ...metadata }; },
		async createAttachment() { backendCalls++; return { ...metadata }; },
		async updateAttachment() { backendCalls++; return { ...metadata }; },
	});
	const denied = createAttachmentService({ backend: bindBackend(backend), permit(permission) { if (permission !== 'read') throw new ServiceError('operation_not_permitted'); }, accountId });
	await assert.rejects(denied.createAttachment({ filename: 'a.bin', contentBase64: 'AA==' }), error => error.code === 'operation_not_permitted');
	await assert.rejects(denied.updateAttachment(resourceId, { title: 'renamed' }), error => error.code === 'operation_not_permitted');
	assert.equal(backendCalls, 0);

	for (const state of [{ encryption_applied: 1 }, { encryption_blob_encrypted: 1 }, { is_locked: 1 }]) {
		const service = createAttachmentService({ backend: bindBackend(fakeBackend({ async getAttachment() { return { ...metadata, ...state }; } })), permit() {}, accountId });
		await assert.rejects(service.getAttachment(resourceId), error => error.code === 'attachment_unavailable');
	}

	const missing = createAttachmentService({ backend: bindBackend(fakeBackend({ async getAttachment() { throw new ServiceError('not_found'); } })), permit() {}, accountId });
	await assert.rejects(missing.getAttachment(resourceId), error => error.code === 'attachment_unavailable');
});

test('read_attachment returns bytes only in one embedded resource block', async () => {
	const service = createAttachmentService({
		backend: bindBackend(fakeBackend({
			async getNote() { throw new Error('direct resource reads have no parent-note requirement'); },
			async readAttachment() { return { ...metadata, mime: '', filename: 'diagram.png', contentBase64: 'AAECAw==' }; },
		})),
		permit() {},
		accountId,
	});
	const tools = makeTools(service);
	assert.equal(tools.has('create_attachment'), false);
	assert.equal(tools.has('update_attachment'), false);
	const result = await tools.get('read_attachment').run({ id: resourceId });
	assert.equal(isMcpToolResult(result), true);
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent, { ...metadata, mime: '', accountId, filename: 'diagram.png', uri: `joplin-resource://${resourceId}/diagram.png` });
	assert.equal(result.content[0].type, 'text');
	assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
	assert.deepEqual(result.content[1], {
		type: 'resource',
		resource: { uri: `joplin-resource://${resourceId}/diagram.png`, mimeType: 'application/octet-stream', blob: 'AAECAw==' },
	});
	assert.equal(Object.hasOwn(result.structuredContent, 'contentBase64'), false);
	assert.equal(result.content[0].text.includes('AAECAw=='), false);
});

test('create and update tools are registered only when writes are enabled and upload stays separate from note edits', async () => {
	let created;
	let updated;
	const backend = fakeBackend({
		async createAttachment(input) { created = input; return { ...metadata, id: 'c'.repeat(32) }; },
		async updateAttachment(_id, input) { updated = input; return { ...metadata, filename: 'renamed.pdf' }; },
	});
	const service = createAttachmentService({ backend: bindBackend(backend), permit() {}, accountId });
	const tools = makeTools(service, true);
	assert.equal(tools.has('create_attachment'), true);
	assert.equal(tools.has('update_attachment'), true);
	const upload = await tools.get('create_attachment').run({ filename: 'photo [one].png', content_base64: 'AAECAw==', mime: 'image/png' });
	assert.deepEqual(created, { filename: 'photo [one].png', contentBase64: 'AAECAw==', mime: 'image/png' });
	assert.equal(upload.resource_id, 'c'.repeat(32));
	assert.equal(upload.markdown_link, `[photo \\[one\\].png](:/${'c'.repeat(32)})`);

	const renamed = await tools.get('update_attachment').run({ id: resourceId, filename: 'renamed.pdf', content_base64: 'AQID' });
	assert.deepEqual(updated, { filename: 'renamed.pdf', contentBase64: 'AQID' });
	assert.equal(renamed.filename, 'renamed.pdf');
});

test('update_attachment refuses encrypted resources before changing their bytes or metadata', async () => {
	let writes = 0;
	const service = createAttachmentService({
		backend: bindBackend(fakeBackend({
			async getAttachment() { return { ...metadata, is_locked: 1 }; },
			async updateAttachment() { writes++; return { ...metadata }; },
		})),
		permit() {},
		accountId,
	});
	await assert.rejects(service.updateAttachment(resourceId, { contentBase64: 'AQID' }), error => error.code === 'attachment_unavailable');
	assert.equal(writes, 0);
});
