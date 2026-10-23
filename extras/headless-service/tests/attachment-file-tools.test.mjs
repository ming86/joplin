import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/mcp/tools.mjs';
import { registerAttachmentTools, embeddedResourcesResult, isMcpToolResult } from '../src/mcp/attachment-tools.mjs';
import { ServiceError } from '../src/errors.mjs';

const resourceId = 'b'.repeat(32);
const file = {
	download_url: 'https://files.example.test/attachment?secret=hidden',
	file_id: 'file-attachment',
	mime_type: 'image/png',
	file_name: 'client-name.png',
};

function attachmentToolHarness(service, readFile) {
	const tools = new Map();
	registerAttachmentTools((name, description, inputSchema, run, annotations, metadata) => {
		tools.set(name, { description, inputSchema, run, annotations, metadata });
	}, service, { allowWrites: true, readFile });
	return tools;
}

test('embeddedResourcesResult keeps metadata first and marks all resource blocks as native content', () => {
	const metadata = { id: resourceId, count: 2 };
	const resources = [
		{ uri: 'joplin-resource://one', mimeType: 'application/octet-stream', blob: 'AA==' },
		{ uri: 'joplin-resource://two', mimeType: 'image/png', blob: 'AQ==' },
	];
	const result = embeddedResourcesResult(metadata, resources);
	assert.equal(isMcpToolResult(result), true);
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent, metadata);
	assert.deepEqual(result.content, [
		{ type: 'text', text: JSON.stringify(metadata) },
		...resources.map(resource => ({ type: 'resource', resource })),
	]);
});

test('attachment file inputs preserve arbitrary bytes and use only explicitly selected metadata', async () => {
	const bytes = Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x00, 0xfe]);
	const reads = [];
	const writes = [];
	const signal = new AbortController().signal;
	const service = {
		async createAttachment(input, receivedSignal) { writes.push({ operation: 'create', input, receivedSignal }); return { id: 'c'.repeat(32) }; },
		async updateAttachment(id, input, receivedSignal) { writes.push({ operation: 'update', id, input, receivedSignal }); return { id }; },
	};
	const tools = attachmentToolHarness(service, async (fileInput, receivedSignal) => {
		reads.push({ fileInput, receivedSignal });
		return bytes;
	});

	const created = await tools.get('create_attachment').run({
		filename: 'chosen.bin', content_file: file, title: 'Chosen title', mime: 'application/x-explicit',
	}, signal);
	const updated = await tools.get('update_attachment').run({
		id: resourceId, content_file: file, filename: 'replacement.bin', mime: 'application/x-replacement',
	}, signal);

	assert.deepEqual(reads, [
		{ fileInput: file, receivedSignal: signal },
		{ fileInput: file, receivedSignal: signal },
	]);
	assert.equal(writes.length, 2);
	assert.equal(writes[0].operation, 'create');
	assert.equal(writes[0].receivedSignal, signal);
	assert.deepEqual(writes[0].input, {
		filename: 'chosen.bin',
		contentBase64: bytes.toString('base64'),
		title: 'Chosen title',
		mime: 'application/x-explicit',
	});
	assert.equal(writes[1].operation, 'update');
	assert.equal(writes[1].id, resourceId);
	assert.equal(writes[1].receivedSignal, signal);
	assert.deepEqual(writes[1].input, {
		filename: 'replacement.bin',
		mime: 'application/x-replacement',
		contentBase64: bytes.toString('base64'),
	});
	assert.equal(Buffer.from(writes[0].input.contentBase64, 'base64').equals(bytes), true);
	assert.equal(created.filename, 'chosen.bin', 'the required filename is kept instead of file.file_name');
	assert.equal(created.mime, undefined, 'file.mime_type does not change the explicit MIME field');
	assert.equal(updated.id, resourceId);
	assert.equal(JSON.stringify(created).includes(bytes.toString('base64')), false);
	assert.equal(JSON.stringify(updated).includes(bytes.toString('base64')), false);
});

test('attachment file input schemas publish client file parameters and retain usable update shapes', async () => {
	let reads = 0;
	let writes = 0;
	const catalog = createTools({
		async createAttachment() { writes++; return { id: resourceId }; },
	}, { allowWrites: true, async readFile() { reads++; return Buffer.from([0xff]); } });
	const tools = catalog.list();
	const create = tools.find(tool => tool.name === 'create_attachment');
	const update = tools.find(tool => tool.name === 'update_attachment');
	for (const definition of [create, update]) {
		assert.deepEqual(definition._meta, { 'openai/fileParams': ['content_file'] });
		assert.deepEqual(Object.keys(definition.inputSchema.properties.content_file.properties), [
			'download_url', 'file_id', 'mime_type', 'file_name',
		]);
		assert.deepEqual(definition.inputSchema.properties.content_file.required, ['download_url', 'file_id']);
		assert.equal(definition.inputSchema.properties.content_file.additionalProperties, false);
		assert.match(definition.inputSchema.properties.content_file.description, /content_file for binary or large files/);
	}
	assert.deepEqual(create.inputSchema.required, ['filename']);
	assert.deepEqual(create.inputSchema.anyOf, [
		{ required: ['content_base64'] },
		{ required: ['content_file'] },
	]);
	assert.equal(create.inputSchema.additionalProperties, false);
	assert.deepEqual(create.inputSchema.not, { required: ['content_base64', 'content_file'] });
	assert.match(create.description, /content_file for binary or large files/);
	assert.deepEqual(update.inputSchema.required, ['id']);
	assert.equal(update.inputSchema.minProperties, 2);
	assert.equal(Object.hasOwn(update.inputSchema, 'anyOf'), false);
	assert.deepEqual(update.inputSchema.not, { required: ['content_base64', 'content_file'] });
	assert.match(update.description, /content_file for binary or large replacements/);
	assert.match(update.description, /Joplin note history does not preserve the previous binary contents/);

	for (const args of [
		{ filename: 'missing-content.bin' },
		{ content_base64: '/w==' },
		{ filename: 'unknown-root.bin', content_base64: '/w==', local_path: '/tmp/file.bin' },
		{ filename: 'unknown-file-field.bin', content_file: { ...file, local_path: '/tmp/file.bin' } },
	]) {
		const result = await catalog.call('create_attachment', args);
		assert.equal(result.structuredContent.error.code, 'invalid_tool_arguments');
	}
	assert.equal(reads, 0);
	assert.equal(writes, 0);
});

test('metadata-only attachment updates remain valid with the compact update schema', async () => {
	let saved;
	const catalog = createTools({
		async updateAttachment(id, input) { saved = { id, input }; return { id }; },
	}, { allowWrites: true });
	const result = await catalog.call('update_attachment', { id: resourceId, title: 'Renamed title' });
	assert.equal(result.isError, false);
	assert.deepEqual(saved, { id: resourceId, input: { title: 'Renamed title' } });
});

test('conflicting content sources fail before downloading or writing', async () => {
	let reads = 0;
	let writes = 0;
	const tools = attachmentToolHarness({
		async createAttachment() { writes++; return { id: 'c'.repeat(32) }; },
		async updateAttachment() { writes++; return { id: resourceId }; },
	}, async () => { reads++; return Buffer.from([0xff]); });

	await assert.rejects(
		tools.get('create_attachment').run({ filename: 'a.bin', content_base64: '/w==', content_file: file }),
		error => error.code === 'attachment_content_conflict',
	);
	await assert.rejects(
		tools.get('update_attachment').run({ id: resourceId, content_base64: '/w==', content_file: file }),
		error => error.code === 'attachment_content_conflict',
	);
	assert.equal(reads, 0);
	assert.equal(writes, 0);
});

test('file read cancellation and failures happen before attachment writes', async () => {
	let writes = 0;
	const controller = new AbortController();
	controller.abort();
	const tools = attachmentToolHarness({
		async createAttachment() { writes++; return { id: 'c'.repeat(32) }; },
		async updateAttachment() { writes++; return { id: resourceId }; },
	}, async (_file, signal) => {
		if (signal?.aborted) throw new ServiceError('request_cancelled');
		throw new Error('download failed');
	});

	await assert.rejects(
		tools.get('update_attachment').run({ id: resourceId, content_file: file }, controller.signal),
		error => error.code === 'request_cancelled',
	);
	await assert.rejects(
		tools.get('create_attachment').run({ filename: 'a.bin', content_file: file }),
		error => error.message === 'download failed',
	);
	assert.equal(writes, 0);
});
