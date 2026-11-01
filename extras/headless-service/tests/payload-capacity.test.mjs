import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayloadCapacity, defaultActivePayloadBytes, defaultRetainedExportBytes } from '../src/payload-capacity.mjs';
import { createMcpSession } from '../src/mcp/session.mjs';

/** Build independent modern requests without a legacy initialization handshake. */
function resourceRequest(id = 1) {
	return { jsonrpc: '2.0', id, method: 'resources/read', params: {
		uri: 'joplin-note-file://test/export.md',
		_meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
	} };
}

/** Provide the session's required store contract with a focused resource-read implementation. */
function resourceStore(read) {
	return { exportNote() {}, read, list() { return []; }, close() {} };
}

test('payload capacity shares reservations and leaves ownership unchanged on rejection', t => {
	t.mock.method(console, 'error', () => {});
	assert.equal(defaultActivePayloadBytes, 128 * 1024 * 1024);
	assert.equal(defaultRetainedExportBytes, 256 * 1024 * 1024);
	const capacity = createPayloadCapacity({ limitBytes: 10 });
	const first = capacity.createOwner({ operation: 'file_download', stage: 'collect' });
	const second = capacity.createOwner({ operation: 'resource_read', stage: 'response' });
	first.reserve(8);
	assert.equal(first.capacity, capacity);
	assert.equal(first.usedBytes, 8);
	assert.throws(() => second.reserve(3), error => {
		assert.equal(error.code, 'resource_capacity_exceeded');
		assert.equal(error.outcomeUnknown, false);
		assert.match(error.message, /occupied/);
		assert.deepEqual(error.diagnostics, { operation: 'resource_read', stage: 'response', usedBytes: 8, requestedBytes: 3, limitBytes: 10 });
		return true;
	});
	assert.equal(capacity.usedBytes, 8);
	assert.equal(second.usedBytes, 0);
	first.release();
	first.release();
	assert.equal(capacity.usedBytes, 0);
	assert.equal(first.usedBytes, 0);
	assert.throws(() => first.reserve(1), /payload_owner_released/);
	second.reserve(10);
	assert.throws(() => second.reserve(1), error => error.code === 'resource_capacity_exceeded' && /exceeds/.test(error.message));
	assert.equal(capacity.usedBytes, 10);
	second.release();
	assert.equal(capacity.usedBytes, 0);
});

test('session preserves transport response ownership and releases standalone owners', async () => {
	const capacity = createPayloadCapacity({ limitBytes: 10 });
	let observedOwner;
	const store = resourceStore((uri, owner) => {
		observedOwner = owner;
		owner.reserve(4);
		return { contents: [{ uri, blob: 'test' }] };
	});
	const session = createMcpSession({}, { payloadCapacity: capacity, noteFileResources: store });
	assert.equal(session.payloadCapacity, capacity);
	const response = await session.handle(resourceRequest());
	assert.equal(response.result.contents.length, 1);
	assert.equal(observedOwner.usedBytes, 0);
	assert.equal(capacity.usedBytes, 0);
	const requestPayload = capacity.createOwner({ operation: 'transport_request' });
	const responsePayload = capacity.createOwner({ operation: 'transport_response' });
	requestPayload.reserve(2);
	await session.handle(resourceRequest(2), { requestPayload, responsePayload });
	assert.equal(observedOwner, responsePayload);
	assert.equal(capacity.usedBytes, 6);
	session.close();
	assert.equal(capacity.usedBytes, 6);
	requestPayload.release();
	responsePayload.release();
	assert.equal(capacity.usedBytes, 0);
});

test('resource-read saturation returns a capacity error and releases fallback ownership', async t => {
	t.mock.method(console, 'error', () => {});
	const capacity = createPayloadCapacity({ limitBytes: 3 });
	const store = resourceStore((uri, owner) => { owner.reserve(4); return { contents: [] }; });
	const session = createMcpSession({}, { payloadCapacity: capacity, noteFileResources: store });
	try {
		const response = await session.handle(resourceRequest());
		assert.equal(response.error.code, -32000);
		assert.deepEqual(response.error.data, { code: 'resource_capacity_exceeded' });
		assert.match(response.error.message, /exceeds/);
		assert.equal(capacity.usedBytes, 0);
	} finally { session.close(); }
});
