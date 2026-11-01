import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentClient } from '../src/attachment-client.mjs';
import { logOperationError } from '../src/diagnostics.mjs';
import { createPayloadCapacity } from '../src/payload-capacity.mjs';

const noteId = 'a'.repeat(32);
const firstResourceId = 'b'.repeat(32);
const secondResourceId = 'c'.repeat(32);
const createdResourceId = 'd'.repeat(32);
const token = 'test-token';

function resource(id, fields = {}) {
	return {
		id,
		title: 'attachment.bin',
		mime: 'application/octet-stream',
		file_extension: 'bin',
		size: 0,
		created_time: 10,
		updated_time: 11,
		encryption_applied: 0,
		encryption_blob_encrypted: 0,
		is_locked: 0,
		...fields,
	};
}

function createFixture() {
	const resources = new Map([
		[firstResourceId, resource(firstResourceId)],
		[secondResourceId, resource(secondResourceId, { title: 'second.txt', mime: 'text/plain', file_extension: 'txt' })],
	]);
	const files = new Map([[firstResourceId, Buffer.from([0, 1, 2, 127, 128, 255])]]);
	const calls = [];
	let actionReply;
	const baseUrl = 'http://127.0.0.1/';

	async function request(route, params = {}, method = 'GET', body, signal, options = {}) {
		calls.push({ route, params, method, body, hasSignal: Boolean(signal), options });
		if (method === 'GET' && route === `notes/${noteId}/resources`) {
			const page = Number(params.page);
			return page === 1
				? { items: [resources.get(firstResourceId)], has_more: true }
				: { items: [resources.get(secondResourceId)], has_more: false };
		}
		if (method === 'GET' && route.startsWith('resources/')) {
			return resources.get(route.slice('resources/'.length));
		}
		if (method === 'POST' && route === 'services/headless') {
			if (actionReply !== undefined) return actionReply;
			if (body.action === 'createAttachment') {
				return resource(createdResourceId, {
					title: body.title ?? body.filename,
					mime: body.mime ?? 'application/octet-stream',
					file_extension: body.filename.includes('.') ? body.filename.split('.').at(-1) : '',
				});
			}
			const current = resources.get(body.id) ?? resource(body.id);
			return resource(body.id, {
				...current,
				...(body.title === undefined ? {} : { title: body.title }),
				...(body.filename === undefined ? {} : {
					title: body.filename,
					file_extension: body.filename.includes('.') ? body.filename.split('.').at(-1) : '',
				}),
				...(body.mime === undefined ? {} : { mime: body.mime }),
				...(body.contentBase64 === undefined ? {} : { size: Buffer.from(body.contentBase64, 'base64').length }),
				updated_time: current.updated_time + 1,
			});
		}
		throw new Error(`Unexpected fixture request: ${method} ${route}`);
	}

	return {
		client: createAttachmentClient({ request, baseUrl, token, timeoutMs: 3000 }),
		resources,
		files,
		calls,
		setActionReply(value) { actionReply = value; },
	};
}

test('attachment listing follows Data API pages and binary reads still fetch the resource file', async t => {
	const fixture = createFixture();
	const listed = await fixture.client.listNoteAttachments(noteId);
	assert.deepEqual(listed.map(item => item.id), [firstResourceId, secondResourceId]);
	assert.equal(fixture.calls.filter(call => call.route === `notes/${noteId}/resources`).length, 2);
	assert.equal(listed[0].encryption_applied, 0);
	assert.equal(listed[0].is_locked, 0);

	fixture.resources.set(firstResourceId, resource(firstResourceId, { mime: '' }));
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async input => {
		const url = new URL(input);
		assert.equal(url.pathname, `/resources/${firstResourceId}/file`);
		assert.equal(url.searchParams.get('token'), token);
		return new Response(fixture.files.get(firstResourceId), {
			status: 200,
			headers: { 'Content-Type': 'application/octet-stream' },
		});
	};
	let read;
	try { read = await fixture.client.readAttachment(firstResourceId); }
	finally { globalThis.fetch = originalFetch; }
	assert.equal(read.filename, 'attachment.bin');
	assert.equal(read.mime, '', 'an empty stored MIME stays empty even when the file response has a content type');
	assert.equal(read.contentBase64, fixture.files.get(firstResourceId).toString('base64'));
	assert.equal(read.size, fixture.files.get(firstResourceId).length);
	assert.equal(fixture.calls.some(call => call.route === `resources/${firstResourceId}/file`), false);
});

test('create and update use fixed native actions with their complete metadata responses', async t => {
	const fixture = createFixture();
	const contentBase64 = Buffer.from([3, 4, 5]).toString('base64');
	const created = await fixture.client.createAttachment({
		filename: 'résumé.bin', contentBase64, title: 'Résumé', mime: 'application/x-example',
	});
	assert.equal(created.id, createdResourceId);
	assert.equal(created.title, 'Résumé');
	assert.equal(created.filename, 'Résumé.bin');
	assert.equal(created.mime, 'application/x-example');

	const updated = await fixture.client.updateAttachment(firstResourceId, {
		filename: 'renamed.data', mime: 'application/x-test', contentBase64,
	});
	assert.equal(updated.id, firstResourceId);
	assert.equal(updated.filename, 'renamed.data');
	assert.equal(updated.mime, 'application/x-test');
	const writes = fixture.calls.filter(call => call.route === 'services/headless');
	assert.deepEqual(writes.map(call => call.body), [
		{
			action: 'createAttachment', filename: 'résumé.bin', contentBase64,
			title: 'Résumé', mime: 'application/x-example',
		},
		{
			action: 'updateAttachment', id: firstResourceId, filename: 'renamed.data',
			contentBase64, mime: 'application/x-test',
		},
	]);
	assert.equal(writes.every(call => call.method === 'POST' && call.options.writeOperation === true), true);
});

test('extensionless filename and MIME are passed to core without client-side extension pinning', async t => {
	const fixture = createFixture();
	const contentBase64 = 'AQ==';
	fixture.setActionReply(resource(createdResourceId, {
		title: 'report', mime: 'application/pdf', file_extension: 'pdf', size: 1,
	}));
	const created = await fixture.client.createAttachment({ filename: 'report', contentBase64, mime: 'application/pdf' });
	assert.equal(created.filename, 'report.pdf');
	assert.deepEqual(fixture.calls.at(-1).body, {
		action: 'createAttachment', filename: 'report', contentBase64, mime: 'application/pdf',
	});
});

test('local validation rejects unsafe input before sending a native action', async t => {
	const fixture = createFixture();
	await assert.rejects(fixture.client.createAttachment({ filename: '../bad.bin', contentBase64: 'AQ==' }), { code: 'invalid_attachment_input' });
	await assert.rejects(fixture.client.createAttachment({ filename: 'bad.bin', contentBase64: 'ab!=' }), { code: 'invalid_attachment_input' });
	await assert.rejects(fixture.client.updateAttachment(firstResourceId, { file_extension: 'bin' }), { code: 'unsupported_attachment_property' });
	assert.equal(fixture.calls.some(call => call.route === 'services/headless'), false);
});

test('known prewrite errors are mapped safely while unknown write results stay uncertain without retry', async t => {
	const fixture = createFixture();
	fixture.setActionReply({ error: { code: 'invalid_attachment_input', message: 'raw backend detail', applied: false } });
	await assert.rejects(fixture.client.createAttachment({ filename: 'bad.bin', contentBase64: 'AQ==' }), error => {
		assert.equal(error.code, 'invalid_attachment_input');
		assert.equal(error.outcomeUnknown, false);
		assert.notEqual(error.message, 'raw backend detail');
		assert.equal(error.diagnostics.operation, 'createAttachment');
		assert.equal(error.diagnostics.path, 'services/headless');
		assert.equal(error.diagnostics.stage, 'validation');
		return true;
	});
	assert.equal(fixture.calls.filter(call => call.route === 'services/headless').length, 1);

	fixture.setActionReply({ error: { code: 'unknown_core_error', message: 'secret payload', applied: false } });
	await assert.rejects(fixture.client.updateAttachment(firstResourceId, { title: 'changed' }), error => {
		assert.equal(error.code, 'write_outcome_unknown');
		assert.equal(error.outcomeUnknown, true);
		assert.notEqual(error.message, 'secret payload');
		assert.equal(error.diagnostics.operation, 'updateAttachment');
		assert.equal(error.diagnostics.stage, 'validation');
		return true;
	});
	assert.equal(fixture.calls.filter(call => call.route === 'services/headless').length, 2);
});

test('malformed metadata or a mismatched update id reports uncertainty without another write', async t => {
	const fixture = createFixture();
	fixture.setActionReply({ id: createdResourceId, title: 'missing required metadata' });
	await assert.rejects(fixture.client.createAttachment({ filename: 'report.txt', contentBase64: 'AQ==' }), error => {
		assert.equal(error.code, 'write_outcome_unknown');
		assert.equal(error.outcomeUnknown, true);
		assert.equal(error.cause.code, 'invalid_backend_response');
		assert.equal(error.diagnostics.operation, 'createAttachment');
		assert.equal(error.diagnostics.path, 'services/headless');
		assert.equal(error.diagnostics.stage, 'validation');
		return true;
	});

	fixture.setActionReply(resource(secondResourceId));
	await assert.rejects(fixture.client.updateAttachment(firstResourceId, { title: 'changed' }), { code: 'write_outcome_unknown', outcomeUnknown: true });
	assert.equal(fixture.calls.filter(call => call.route === 'services/headless').length, 2);
});

test('binary read failures retain their cause and log only fixed route metadata', async () => {
	const fixture = createFixture();
	const originalFetch = globalThis.fetch;
	const networkError = new Error(`failed https://files.example/file?token=${token} secret-body`);
	let logged;
	globalThis.fetch = async () => { throw networkError; };
	try {
		await assert.rejects(fixture.client.readAttachment(firstResourceId), error => {
			assert.equal(error.code, 'backend_unavailable');
			assert.equal(error.cause, networkError);
			assert.equal(error.diagnostics.method, 'GET');
			assert.equal(error.diagnostics.path, 'resources/id/file');
			assert.equal(error.diagnostics.operation, 'readAttachment');
			const originalError = console.error;
			console.error = value => { logged = value; };
			try { logOperationError(error, { tool: 'read_attachment', operation: 'readAttachment' }); }
			finally { console.error = originalError; }
			assert.ok(!logged.includes(token));
			assert.ok(!logged.includes('secret-body'));
			assert.ok(!logged.includes(firstResourceId));
			return true;
		});

		const bodyError = new Error(`body contained private text ${token}`);
		globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(bodyError); } }));
		await assert.rejects(fixture.client.readAttachment(firstResourceId), error => {
			assert.equal(error.code, 'attachment_file_unavailable');
			assert.equal(error.cause, bodyError);
			assert.equal(error.diagnostics.stage, 'body');
			assert.equal(error.diagnostics.status, 200);
			return true;
		});

		globalThis.fetch = async () => new Response('private response body', { status: 404 });
		await assert.rejects(fixture.client.readAttachment(firstResourceId), error => {
			assert.equal(error.code, 'not_found');
			assert.equal(error.diagnostics.status, 404);
			assert.equal(error.diagnostics.path, 'resources/id/file');
			return true;
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});


test('attachment reads charge chunks before retaining bytes and keep binary and base64 owned through response cleanup', async () => {
	const fixture = createFixture();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array([0, 1, 2])); controller.enqueue(new Uint8Array([3, 4, 5])); controller.close(); },
	}));
	try {
		const capacity = createPayloadCapacity({ limitBytes: 14 });
		const owner = capacity.createOwner({ operation: 'read_attachment' });
		const result = await fixture.client.readAttachment(firstResourceId, undefined, owner);
		assert.equal(result.contentBase64, Buffer.from([0, 1, 2, 3, 4, 5]).toString('base64'));
		assert.equal(capacity.usedBytes, 14, 'six binary bytes plus eight encoded bytes remain owned');
		owner.release();
		assert.equal(capacity.usedBytes, 0);

		for (const limitBytes of [5, 13]) {
			const small = createPayloadCapacity({ limitBytes });
			const partial = small.createOwner({ operation: 'read_attachment' });
			await assert.rejects(fixture.client.readAttachment(firstResourceId, undefined, partial), error => {
				assert.equal(error.code, 'resource_capacity_exceeded', 'collection and encoding capacity failures retain their stable error');
				return true;
			});
			assert.equal(small.usedBytes, limitBytes === 5 ? 3 : 6);
			partial.release();
			assert.equal(small.usedBytes, 0);
		}
	} finally { globalThis.fetch = originalFetch; }
});
