import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNoteFileResources } from '../src/mcp/note-file-resources.mjs';
import { createPayloadCapacity } from '../src/payload-capacity.mjs';

test('text exports preserve exact UTF-8 snapshots, hashes, metadata, and shared expiry lifecycle', () => {
	let time = 10_000;
	const store = createNoteFileResources({ now: () => time, lifetimeMs: 500 });
	try {
		const historicalText = 'Earlier body\r\n📝 café\n';
		const historical = store.exportText({
			text: historicalText,
			filename: 'note-history.md',
			mimeType: 'text/markdown; charset=utf-8',
		});

		time += 100;
		const conflictText = '<<<<<<< current\nCurrent body\n=======\nEarlier body\n>>>>>>> history\n';
		const conflict = store.exportText({
			text: conflictText,
			filename: 'note-conflict.diff',
			mimeType: 'text/x-diff; charset=utf-8',
		});

		time += 100;
		const comparisonText = '--- earlier\n+++ current\n-old\n+new\n';
		const comparison = store.exportText({
			text: comparisonText,
			filename: 'earlier-to-current.diff',
			mimeType: 'text/x-diff; charset=utf-8',
		});

		for (const { exported, text, filename, mimeType } of [
			{ exported: historical, text: historicalText, filename: 'note-history.md', mimeType: 'text/markdown; charset=utf-8' },
			{ exported: conflict, text: conflictText, filename: 'note-conflict.diff', mimeType: 'text/x-diff; charset=utf-8' },
			{ exported: comparison, text: comparisonText, filename: 'earlier-to-current.diff', mimeType: 'text/x-diff; charset=utf-8' },
		]) {
			const bytes = Buffer.from(text, 'utf8');
			assert.equal(exported.file.filename, filename);
			assert.equal(exported.file.mime_type, mimeType);
			assert.equal(exported.file.size, bytes.length);
			assert.equal(exported.file.sha256, createHash('sha256').update(bytes).digest('hex'));
			assert.equal(new Date(exported.file.expires_at).toISOString(), exported.file.expires_at);
			assert.deepEqual(exported.resource, {
				uri: exported.file.uri,
				mimeType,
				blob: bytes.toString('base64'),
			});
			assert.deepEqual(store.read(exported.file.uri), { contents: [exported.resource] });
			assert.equal(Buffer.from(store.read(exported.file.uri).contents[0].blob, 'base64').toString('utf8'), text);
			assert.deepEqual(Object.keys(exported), ['file', 'resource']);
			assert.equal(decodeURIComponent(exported.file.uri.split('/').at(-1)), filename);
		}

		assert.deepEqual(store.list(), [historical, conflict, comparison].map(({ file }) => ({
			name: file.filename,
			mimeType: file.mime_type,
			size: file.size,
			uri: file.uri,
		})));
		assert.equal(Object.hasOwn(conflict.file, 'revision_id'), false);
		assert.equal(Object.hasOwn(conflict.file, 'id'), false);

		time += 300;
		assert.deepEqual(store.list().map(entry => entry.uri), [conflict.file.uri, comparison.file.uri]);
		assert.throws(() => store.read(historical.file.uri), error => error.code === 'note_file_unavailable');
		time += 100;
		assert.deepEqual(store.list().map(entry => entry.uri), [comparison.file.uri]);
		time += 100;
		assert.deepEqual(store.list(), []);
		assert.throws(() => store.read(comparison.file.uri), error => error.code === 'note_file_unavailable');
	} finally {
		store.close();
	}
});

test('text exports require caller-supplied text and contextual file metadata', () => {
	const store = createNoteFileResources();
	try {
		assert.throws(() => store.exportText({ text: 'body', filename: 'body.md' }), error => error.code === 'invalid_text_export_input');
		assert.throws(() => store.exportText({ text: 'body', filename: '', mimeType: 'text/plain' }), error => error.code === 'invalid_text_export_input');
		assert.throws(() => store.exportText({ text: 1, filename: 'body.md', mimeType: 'text/plain' }), error => error.code === 'invalid_text_export_input');
	} finally {
		store.close();
	}
});


test('retained saturation preserves earlier exports and expiry and close release their bytes', () => {
	let time = 100;
	const payloadCapacity = createPayloadCapacity({ limitBytes: 32 });
	const storedCapacity = createPayloadCapacity({ limitBytes: 6 });
	const store = createNoteFileResources({ now: () => time, lifetimeMs: 100, payloadCapacity, storedCapacity });
	const input = text => ({ text, filename: 'body.md', mimeType: 'text/markdown' });
	try {
		const first = store.exportText(input('café'));
		assert.equal(storedCapacity.usedBytes, 5, 'stored capacity counts UTF-8 bytes');
		assert.equal(payloadCapacity.usedBytes, 0, 'direct store calls release temporary response reservations');
		assert.throws(() => store.exportText(input('xx')), error => error.code === 'resource_capacity_exceeded');
		assert.equal(storedCapacity.usedBytes, 5);
		assert.deepEqual(store.list().map(entry => entry.uri), [first.file.uri]);
		assert.equal(Buffer.from(store.read(first.file.uri).contents[0].blob, 'base64').toString(), 'café');
		time += 100;
		assert.deepEqual(store.list(), []);
		assert.equal(storedCapacity.usedBytes, 0);
		store.exportText(input('new'));
		assert.equal(storedCapacity.usedBytes, 3);
	} finally { store.close(); }
	assert.equal(storedCapacity.usedBytes, 0);
});

test('temporary response saturation preserves exports and failed export batches retain no unreturned entries', () => {
	const payloadCapacity = createPayloadCapacity({ limitBytes: 12 });
	const storedCapacity = createPayloadCapacity({ limitBytes: 8 });
	const store = createNoteFileResources({ payloadCapacity, storedCapacity });
	const input = text => ({ text, filename: 'body.md', mimeType: 'text/markdown' });
	try {
		const first = store.exportText(input('old'));
		const occupied = payloadCapacity.createOwner({ operation: 'other_request' });
		occupied.reserve(10);
		assert.throws(() => store.read(first.file.uri), error => error.code === 'resource_capacity_exceeded');
		assert.equal(storedCapacity.usedBytes, 3);
		assert.equal(store.list()[0].uri, first.file.uri);
		assert.throws(() => store.exportText(input('new')), error => error.code === 'resource_capacity_exceeded');
		assert.equal(storedCapacity.usedBytes, 3, 'response failure also releases the new retained entry');
		occupied.release();
		assert.equal(store.read(first.file.uri).contents[0].blob, first.resource.blob);
		assert.throws(() => store.exportTexts([input('abc'), input('def')]), error => error.code === 'resource_capacity_exceeded');
		assert.equal(storedCapacity.usedBytes, 3, 'second-entry failure rolls back the entire new batch');
		assert.deepEqual(store.list().map(entry => entry.uri), [first.file.uri]);
		assert.equal(payloadCapacity.usedBytes, 0);

		const responseOwner = payloadCapacity.createOwner({ operation: 'read_export' });
		store.read(first.file.uri, responseOwner);
		assert.equal(payloadCapacity.usedBytes, 4, 'supplied owners retain base64 bytes through transport cleanup');
		responseOwner.release();
	} finally { store.close(); }
	assert.equal(storedCapacity.usedBytes, 0);
	assert.equal(payloadCapacity.usedBytes, 0);
});
