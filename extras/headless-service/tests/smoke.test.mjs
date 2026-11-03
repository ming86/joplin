import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAccount } from '../scripts/check-account.mjs';
import { server, readJson, note, noteId, folderId } from './fixtures.mjs';

test('smoke runner uses read-only requests and no actual embedding endpoint (fake API self-test)', async t => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-smoke-'));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	fs.writeFileSync(`${temp}/token`, 'only-test-token\n', { mode: 0o600 });
	const methods = [];
	const baseUrl = await server(t, async (req, res) => {
		methods.push(req.method);
		const url = new URL(req.url, 'http://loopback');
		assert.equal(url.searchParams.get('token'), 'only-test-token');
		if (req.method === 'POST') {
			assert.equal(url.pathname, '/services/headless');
			assert.deepEqual(await readJson(req), { action: 'searchNotes', query: 'Test', page: 1, limit: 100 });
			return res.end(JSON.stringify({ items: [note], hasMore: false, total: 1 }));
		}
		if (url.pathname.startsWith('/notes/')) return res.end(JSON.stringify(note));
		if (url.pathname === '/folders') return res.end(JSON.stringify({ items: [{ id: folderId, title: 'Test' }], has_more: false }));
		if (url.pathname === '/events') return res.end(JSON.stringify({ items: [], cursor: '0', has_more: false }));
		return res.end(JSON.stringify({ items: [note], has_more: false }));
	});
	const logs = [];
	const result = await checkAccount({ confirmRealCore: true, expectedNoteId: noteId, searchQuery: 'Test', accountId: 'test', subject: 'verified-test', baseUrl, apiTokenFile: `${temp}/token`, semanticDatabasePath: `${temp}/semantic.db`, semanticKeyRef: 'test/key' }, line => logs.push(line));
	assert.equal(result.status, 'PASS');
	assert.equal(result.embedding, 'fake-provider-only');
	assert.deepEqual(methods, ['GET', 'GET', 'POST', 'GET']);
	assert(!fs.existsSync(`${temp}/semantic.db`));
	assert(!logs.join('\n').includes('only-test-token'));
});
