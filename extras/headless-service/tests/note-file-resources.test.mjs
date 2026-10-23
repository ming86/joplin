import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNoteFileResources } from '../src/mcp/note-file-resources.mjs';

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
