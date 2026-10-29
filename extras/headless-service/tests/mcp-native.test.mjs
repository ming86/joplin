import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createAccountRegistry } from '../index.mjs';
import { createTools } from '../src/mcp/tools.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StdioTestClient } from '../scripts/lib/stdio-client.mjs';

/** Built native CLI under test; rebuild app-cli after action changes, since tsc alone can leave build/headless stale. */
const cli = process.env.JOPLIN_MCP_TEST_CLI;
/** Installed SQLite implementation; use its absolute module path when it is outside the CLI's dependencies. */
const sqliteModule = process.env.JOPLIN_HEADLESS_SQLITE_MODULE;

test('MCP over stdio -> actual encrypted Joplin API, FTS, E2EE filesystem sync and normal-mode client', {
	skip: !cli || !sqliteModule ? 'Set JOPLIN_MCP_TEST_CLI and JOPLIN_HEADLESS_SQLITE_MODULE to the installed encrypted runtime.' : false,
	timeout: 180000,
}, async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-mcp-native-'));
	const key = randomBytes(32).toString('hex');
	const token = randomBytes(32).toString('hex');
	const password = randomBytes(24).toString('hex'); // Disposable test identity only, never an existing user key.
	const profile = path.join(dir, 'headless'); const normalProfile = path.join(dir, 'normal'); const syncPath = path.join(dir, 'sync');
	fs.mkdirSync(syncPath); fs.mkdirSync(path.join(dir, 'home'));
	const headlessEnv = { ...process.env, HOME: path.join(dir, 'home'), JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: profile, JOPLIN_HEADLESS_KEY_FD: '3' };
	const children = new Set();
	async function stop(child) {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const closed = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
		await closed; clearTimeout(timer);
	}
	t.after(async () => { for (const c of children) await stop(c); fs.rmSync(dir, { recursive: true, force: true }); });
	function start(args, input = '', headless = true) {
		const env = { ...headlessEnv };
		if (!headless) { delete env.JOPLIN_HEADLESS; delete env.JOPLIN_HEADLESS_PROFILE; delete env.JOPLIN_HEADLESS_KEY_FD; }
		const child = spawn(process.execPath, [cli, ...(!headless ? ['--profile', normalProfile] : []), ...args], { env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
		children.add(child);
		child.out = ''; child.err = '';
		child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
		child.stdout.on('data', data => { child.out += data; }); child.stderr.on('data', data => { child.err += data; });
		child.stdio[3].end(headless ? `${key}\n` : ''); child.stdin.end(input);
		return child;
	}
	async function command(args, input = '', headless = true) {
		const child = start(args, input, headless); const closed = once(child, 'exit');
		const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
		const [code, signal] = await closed; clearTimeout(timer);
		assert.equal(code, 0, `CLI ${args[0]} exit ${code} signal ${signal}; diagnostics retained in memory only`);
		return child.out;
	}
	async function until(check, message, maxMs = 50000) {
		const end = Date.now() + maxMs;
		while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 250)); }
		assert.fail(message);
	}
	const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
	const port = portServer.address().port; await new Promise(r => portServer.close(r));
	const baseUrl = `http://127.0.0.1:${port}`;
	await command(['config', '--import'], JSON.stringify({ 'sync.target': 2, 'sync.2.path': syncPath, 'api.port': port, 'api.token': token }));
	// Upstream testing flag with a freshly generated disposable secret; nothing logged or uploaded.
	await command(['e2ee', 'enable', '--password', password]);
	assert.match(await command(['e2ee', 'status']), /Enabled/);
	await command(['sync']); // Initial target/key setup before measuring MCP, not used to force MCP changes.
	const daemon = start(['serve']);
	await until(() => daemon.out.includes('headless: private API ready'), 'headless API did not become ready');
	async function raw(route, method = 'GET', data) {
		const url = new URL(route, baseUrl); url.searchParams.set('token', token);
		const res = await fetch(url, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
		assert.equal(res.ok, true, `Setup API HTTP ${res.status}`); return res.json();
	}
	const unauthorized = await fetch(`${baseUrl}/notes`); assert.ok([401, 403].includes(unauthorized.status)); await unauthorized.body?.cancel();
	const notebook = await raw('/folders', 'POST', { title: 'Disposable MCP acceptance' });
	const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
	const configFile = path.join(dir, 'mcp.json');
	const conf = { accountId: 'acceptance', baseUrl, apiTokenFile: tokenFile, allowWrites: true };
	fs.writeFileSync(configFile, JSON.stringify(conf));
	const mcp = new StdioTestClient(configFile); t.after(() => mcp.close());
	await mcp.initialize();
	assert.equal((await mcp.request('tools/list')).tools.length, 32);
	const marker = `mcpacceptance${randomBytes(6).toString('hex')}`;
	let result = await mcp.call('create_note', { parentId: notebook.id, title: 'MCP temporary note', body: `${marker} initial 笔记` });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.deepEqual(Object.keys(result.structuredContent).sort(), ['id', 'notebook_id', 'title']);
	const noteId = result.structuredContent.id;
	const conflicts = await mcp.call('list_conflicts');
	assert.equal(conflicts.isError, false, JSON.stringify(conflicts));
	assert.deepEqual(conflicts.structuredContent.items, []);
	assert.equal(conflicts.structuredContent.hasMore, false);
	const ordinaryNoteConflict = await mcp.call('read_conflict', { id: noteId });
	assert.equal(ordinaryNoteConflict.isError, true);
	assert.equal(ordinaryNoteConflict.structuredContent.error.code, 'conflict_not_found');
	const initialRead = await mcp.call('read_note', { id: noteId });
	assert.equal(initialRead.isError, false);
	assert.match(initialRead.structuredContent.revision_id, /^[a-f0-9]{32}$/);
	const initialRevisionId = initialRead.structuredContent.revision_id;
	result = await mcp.call('update_note', { id: noteId, base_revision_id: initialRevisionId, body: `${marker} revised 😀` }); assert.equal(result.isError, false);
	assert.deepEqual(Object.keys(result.structuredContent).sort(), ['changed', 'id', 'previous_revision_id', 'revision_id', 'updated_time']);
	assert.equal(result.structuredContent.previous_revision_id, initialRevisionId);
	assert.notEqual(result.structuredContent.revision_id, initialRevisionId);
	result = await mcp.call('get_note', { id: noteId }); assert.equal(result.structuredContent.body, `${marker} revised 😀`);
	const history = await mcp.call('list_note_revisions', { note_id: noteId });
	assert.equal(history.isError, false);
	assert.ok(history.structuredContent.items.length >= 2);
	const currentRevisionId = history.structuredContent.items[0].revision_id;
	const historicalRevisionId = history.structuredContent.items.at(-1).revision_id;
	assert.equal(currentRevisionId, result.structuredContent.revision_id);
	const accountHistory = await mcp.call('list_revisions', {
		note_ids: [noteId],
		notebook_ids: [notebook.id],
		limit: 101,
	});
	assert.equal(accountHistory.isError, false, JSON.stringify(accountHistory));
	assert.ok(Object.hasOwn(accountHistory.structuredContent, 'accountEmail'));
	assert.equal(Object.hasOwn(accountHistory.structuredContent, 'accountId'), false);
	assert.equal(accountHistory.structuredContent.limit, 101);
	assert.equal(accountHistory.structuredContent.hasMore, false);
	assert.deepEqual(
		accountHistory.structuredContent.items.map(item => item.revision_id),
		history.structuredContent.items.map(item => item.revision_id),
	);
	const accountCurrentRevisionId = accountHistory.structuredContent.items[0].revision_id;
	const accountHistoricalRevisionId = accountHistory.structuredContent.items.at(-1).revision_id;
	assert.equal(accountCurrentRevisionId, currentRevisionId);
	assert.equal(accountHistoricalRevisionId, historicalRevisionId);
	assert.ok(accountHistory.structuredContent.items.every(item => !Object.hasOwn(item, 'body')));
	assert.ok(accountHistory.structuredContent.items.every(item => item.note_id === noteId));
	assert.ok(accountHistory.structuredContent.items.every(item => item.current_notebook_id === notebook.id));
	assert.ok(accountHistory.structuredContent.items.every(item => item.current_title === 'MCP temporary note'));
	assert.deepEqual(Object.keys(accountHistory.structuredContent.items[0]).sort(), [
		'captured_time', 'current_notebook_id', 'current_title', 'note_id', 'parent_revision_id', 'revision_id',
	]);
	const historical = await mcp.call('read_note_revision', { note_id: noteId, revision_id: accountHistoricalRevisionId });
	assert.equal(historical.isError, false);
	assert.equal(historical.structuredContent.body, `${marker} initial 笔记`);
	const comparison = await mcp.call('compare_note_revisions', {
		note_id: noteId,
		from_revision_id: accountHistoricalRevisionId,
		to_revision_id: accountCurrentRevisionId,
	});
	assert.equal(comparison.isError, false);
	assert.equal(comparison.structuredContent.from_revision_id, accountHistoricalRevisionId);
	assert.equal(comparison.structuredContent.to_revision_id, accountCurrentRevisionId);
	assert.match(comparison.structuredContent.body_diff, /revised/);
	const staleWrite = await mcp.call('update_note', {
		id: noteId,
		base_revision_id: initialRevisionId,
		append: ' stale update',
	});
	assert.equal(staleWrite.isError, true);
	assert.equal(staleWrite.structuredContent.error.code, 'note_conflict');
	assert.equal(staleWrite.structuredContent.error.outcomeUnknown, false);
	assert.equal((await mcp.call('read_note', { id: noteId })).structuredContent.body, `${marker} revised 😀`);

	// Exercise contextual patching through the real encrypted core using only fixture-local note text.
	const patchMarker = `mcppatch${randomBytes(6).toString('hex')}`;
	const patchBody = `${patchMarker} header\n## Alpha\nfirst: old\nkeep alpha\n\n## Beta\nsecond: old\nkeep beta\n${patchMarker} footer`;
	const patchNote = await mcp.call('create_note', {
		parentId: notebook.id,
		title: 'MCP context patch fixture',
		body: patchBody,
	});
	assert.equal(patchNote.isError, false, JSON.stringify(patchNote));
	const patchNoteId = patchNote.structuredContent.id;
	const patchDiscovery = await mcp.call('grep_notes', {
		pattern: patchMarker,
		note_ids: [patchNoteId],
	});
	assert.equal(patchDiscovery.isError, false, JSON.stringify(patchDiscovery));
	assert.equal(patchDiscovery.structuredContent.items.length, 2);
	const baseRevisionId = patchDiscovery.structuredContent.items[0].revision_id;
	assert.ok(patchDiscovery.structuredContent.items.every(item => item.revision_id === baseRevisionId));
	const patchBase = await mcp.call('read_note', { id: patchNoteId });
	assert.equal(patchBase.isError, false);
	assert.equal(patchBase.structuredContent.revision_id, baseRevisionId);
	assert.equal(patchBase.structuredContent.body, patchBody);

	// Navigate the indexed body, then use that exact section snapshot as the edit base.
	await until(async () => {
		const found = await mcp.call('search_notes', { query: 'second' });
		return found.structuredContent.results.some(row => row.id === patchNoteId && row.section === '2');
	}, 'MCP section metadata not present in real FTS results');
	const outlineRead = await mcp.call('read_note', { id: patchNoteId, outline: true });
	assert.equal(outlineRead.isError, false, JSON.stringify(outlineRead));
	assert.equal(outlineRead.structuredContent.revision_id, baseRevisionId);
	assert.deepEqual(outlineRead.structuredContent.outline.map(entry => entry.path), ['0', '1', '2']);
	assert.equal(Object.hasOwn(outlineRead.structuredContent, 'body'), false);
	assert.equal(Object.hasOwn(outlineRead.structuredContent, 'body_offset'), false);
	const betaSection = await mcp.call('get_note', { id: patchNoteId, section: 'Beta' });
	assert.equal(betaSection.isError, false, JSON.stringify(betaSection));
	assert.equal(betaSection.structuredContent.revision_id, baseRevisionId);
	assert.equal(betaSection.structuredContent.body, patchBody.slice(patchBody.indexOf('## Beta')));
	assert.equal(betaSection.structuredContent.section_path, '2');
	assert.equal(betaSection.structuredContent.body_offset, patchBody.indexOf('## Beta'));
	assert.equal(betaSection.structuredContent.body_length, patchBody.length);
	assert.equal(betaSection.structuredContent.nextOffset, null);
	assert.equal(betaSection.structuredContent.is_todo, 0);

	const bodyPatch = `@@\n ${patchMarker} header\n ## Alpha\n-first: old\n+first: new\n+first: added\n keep alpha\n@@\n ## Beta\n-second: old\n+second: new\n keep beta\n ${patchMarker} footer\n`;
	const patched = await mcp.call('update_note', {
		id: patchNoteId,
		base_revision_id: betaSection.structuredContent.revision_id,
		body_patch: bodyPatch,
		title: 'MCP context patch fixture updated',
	});
	assert.equal(patched.isError, false, JSON.stringify(patched));
	assert.deepEqual(Object.keys(patched.structuredContent).sort(), ['changed', 'id', 'previous_revision_id', 'revision_id', 'updated_time']);
	assert.equal(patched.structuredContent.changed, true);
	assert.equal(patched.structuredContent.previous_revision_id, baseRevisionId);
	assert.equal(Object.hasOwn(patched.structuredContent, 'body'), false);
	assert.equal(Object.hasOwn(patched.structuredContent, 'body_patch'), false);
	assert.ok(!JSON.stringify(patched).includes(bodyPatch));
	const patchedBody = `${patchMarker} header\n## Alpha\nfirst: new\nfirst: added\nkeep alpha\n\n## Beta\nsecond: new\nkeep beta\n${patchMarker} footer`;
	const patchRead = await mcp.call('read_note', { id: patchNoteId });
	assert.equal(patchRead.isError, false);
	assert.equal(patchRead.structuredContent.body, patchedBody);
	assert.equal(patchRead.structuredContent.body_total_line_count, 10);
	assert.equal(patchRead.structuredContent.title, 'MCP context patch fixture updated');
	assert.equal(patchRead.structuredContent.revision_id, patched.structuredContent.revision_id);

	const patchHistory = await mcp.call('list_note_revisions', { note_id: patchNoteId });
	assert.equal(patchHistory.isError, false);
	assert.ok(patchHistory.structuredContent.items.some(item => item.revision_id === baseRevisionId));
	assert.ok(patchHistory.structuredContent.items.some(item => item.revision_id === patched.structuredContent.revision_id));
	const patchHistorical = await mcp.call('read_note_revision', { note_id: patchNoteId, revision_id: baseRevisionId });
	assert.equal(patchHistorical.isError, false);
	assert.equal(patchHistorical.structuredContent.body, patchBody);
	const patchComparison = await mcp.call('compare_note_revisions', {
		note_id: patchNoteId,
		from_revision_id: baseRevisionId,
		to_revision_id: patched.structuredContent.revision_id,
	});
	assert.equal(patchComparison.isError, false);
	assert.match(patchComparison.structuredContent.body_diff, /first: old/);
	assert.match(patchComparison.structuredContent.body_diff, /first: added/);
	assert.match(patchComparison.structuredContent.body_diff, /second: new/);

	const stalePatch = await mcp.call('update_note', {
		id: patchNoteId,
		base_revision_id: baseRevisionId,
		body_patch: '@@\n-first: old\n+first: stale\n',
	});
	assert.equal(stalePatch.isError, true);
	assert.equal(stalePatch.structuredContent.error.code, 'note_conflict');
	assert.equal(stalePatch.structuredContent.error.outcomeUnknown, false);
	const beforeFailedPatch = await mcp.call('read_note', { id: patchNoteId });
	const revisionCountBeforeFailedPatch = patchHistory.structuredContent.items.length;
	const failedPatch = await mcp.call('update_note', {
		id: patchNoteId,
		base_revision_id: beforeFailedPatch.structuredContent.revision_id,
		body_patch: `@@\n ## Alpha\n-first: new\n+first: should not be applied\n first: added\n keep alpha\n@@\n ## Beta\n-second: absent\n+second: should not be applied\n keep beta\n`,
		title: 'MCP failed patch must not change title',
	});
	assert.equal(failedPatch.isError, true);
	assert.equal(failedPatch.structuredContent.error.code, 'note_patch_not_found');
	assert.equal(failedPatch.structuredContent.error.outcomeUnknown, false);
	assert.ok(!JSON.stringify(failedPatch).includes('should not be applied'));
	const afterFailedPatch = await mcp.call('read_note', { id: patchNoteId });
	assert.equal(afterFailedPatch.structuredContent.body, beforeFailedPatch.structuredContent.body);
	assert.equal(afterFailedPatch.structuredContent.title, beforeFailedPatch.structuredContent.title);
	assert.equal(afterFailedPatch.structuredContent.updated_time, beforeFailedPatch.structuredContent.updated_time);
	assert.equal(afterFailedPatch.structuredContent.revision_id, beforeFailedPatch.structuredContent.revision_id);
	const historyAfterFailedPatch = await mcp.call('list_note_revisions', { note_id: patchNoteId });
	assert.equal(historyAfterFailedPatch.isError, false);
	assert.equal(historyAfterFailedPatch.structuredContent.items.length, revisionCountBeforeFailedPatch);
	const refreshedOutline = await mcp.call('read_note', { id: patchNoteId, outline: true });
	assert.equal(refreshedOutline.structuredContent.revision_id, patched.structuredContent.revision_id);
	assert.notEqual(refreshedOutline.structuredContent.revision_id, outlineRead.structuredContent.revision_id);
	const oldSnapshot = await mcp.call('read_note_revision', { note_id: patchNoteId, revision_id: outlineRead.structuredContent.revision_id });
	assert.equal(oldSnapshot.structuredContent.body, patchBody, 'outline revisions identify the exact native source snapshot');

	// Exercise file import against the same core; only the already-tested public HTTPS download is injected.
	const fileService = createAccountRegistry([{
		id: 'acceptance', subjects: ['acceptance'], permissions: ['read', 'write'],
		joplin: { baseUrl, token, allowInsecureHttp: true },
		semantic: { databasePath: path.join(dir, 'file-fixture-semantic.sqlite'), keyRef: 'disposable-file-fixture' },
	}], {}).forPrincipal('acceptance', 'acceptance');
	let editedFile;
	const fileTools = createTools(fileService, { allowWrites: true, readBodyFile: async () => editedFile });
	const exported = await fileTools.call('read_note', { id: patchNoteId, output: 'file' });
	assert.equal(exported.isError, false, JSON.stringify(exported));
	assert.equal(Object.hasOwn(exported.structuredContent, 'body'), false);
	const exportedBody = Buffer.from(exported.content[1].resource.blob, 'base64').toString('utf8');
	assert.equal(exportedBody, patchedBody, 'file export contains the complete source, including other sections');
	assert.equal(exported.structuredContent.revision_id, refreshedOutline.structuredContent.revision_id);
	editedFile = exportedBody.replace('second: new', 'second: file roundtrip 😀');
	const imported = await fileTools.call('update_note', {
		id: patchNoteId, base_revision_id: exported.structuredContent.revision_id,
		body_file: { download_url: 'https://fixture.example.test/body.md', file_id: 'native-roundtrip' },
	});
	assert.equal(imported.isError, false, JSON.stringify(imported));
	assert.equal(imported.structuredContent.body_length, editedFile.length);
	assert.equal(imported.structuredContent.body_size_bytes, Buffer.byteLength(editedFile));
	assert.equal(imported.structuredContent.body_sha256, createHash('sha256').update(editedFile).digest('hex'));
	const reexported = await mcp.call('read_note', { id: patchNoteId, output: 'file' });
	assert.equal(reexported.isError, false, JSON.stringify(reexported));
	assert.equal(reexported.structuredContent.revision_id, imported.structuredContent.revision_id);
	assert.equal(Buffer.from(reexported.content[1].resource.blob, 'base64').toString('utf8'), editedFile);
	assert.equal(reexported.structuredContent.file.sha256, imported.structuredContent.body_sha256);
	const staleFile = await fileTools.call('update_note', {
		id: patchNoteId, base_revision_id: exported.structuredContent.revision_id,
		body_file: { download_url: 'https://fixture.example.test/body.md', file_id: 'stale-native-roundtrip' },
	});
	assert.equal(staleFile.structuredContent.error.code, 'note_conflict');
	assert.equal((await mcp.call('delete_note', { id: patchNoteId })).isError, false, 'synthetic navigation note is cleaned up through Trash');
	t.diagnostic('PASS native search/outline/section snapshot, context patch, history, stale guards and complete file roundtrip (HTTPS downloader injected)');

	const destinationNotebook = await mcp.call('create_notebook', { title: 'MCP acceptance destination' });
	assert.equal(destinationNotebook.isError, false);
	const movedNotebook = await mcp.call('update_notebook', {
		id: notebook.id,
		title: 'MCP acceptance renamed notebook',
		parent_id: destinationNotebook.structuredContent.id,
	});
	assert.equal(movedNotebook.isError, false);
	const notebookTree = await mcp.call('list_notebooks');
	const moved = notebookTree.structuredContent.notebooks.find(item => item.id === notebook.id);
	assert.equal(moved.title, 'MCP acceptance renamed notebook');
	assert.equal(moved.parent_id, destinationNotebook.structuredContent.id);

	const tag = await mcp.call('create_tag', { title: `MCP ${marker}` });
	assert.equal(tag.isError, false);
	const tagged = await mcp.call('manage_tags', { note_id: noteId, add: [tag.structuredContent.title] });
	assert.equal(tagged.isError, false);
	const renamedTag = await mcp.call('rename_tag', { id: tag.structuredContent.id, title: `MCP ${marker} renamed` });
	assert.equal(renamedTag.isError, false);
	assert.ok((await mcp.call('read_note', { id: noteId })).structuredContent.tags.includes(`MCP ${marker} renamed`));

	const originalBytes = Buffer.from([0, 1, 2, 127, 128, 255]);
	const uploaded = await mcp.call('create_attachment', {
		filename: 'mcp-acceptance.txt',
		content_base64: originalBytes.toString('base64'),
		mime: 'text/plain',
	});
	assert.equal(uploaded.isError, false);
	assert.match(uploaded.structuredContent.resource_id, /^[a-f0-9]{32}$/);
	const attachmentRead = await mcp.call('read_attachment', { id: uploaded.structuredContent.resource_id });
	assert.equal(attachmentRead.isError, false);
	assert.equal(attachmentRead.content[1].type, 'resource');
	assert.equal(attachmentRead.content[1].resource.blob, originalBytes.toString('base64'));
	const attached = await mcp.call('update_note', {
		id: noteId,
		base_revision_id: (await mcp.call('read_note', { id: noteId })).structuredContent.revision_id,
		append: `\n${uploaded.structuredContent.markdown_link}`,
	});
	assert.equal(attached.isError, false);
	const noteAttachments = await mcp.call('list_note_attachments', { note_id: noteId });
	assert.ok(noteAttachments.structuredContent.attachments.some(item => item.id === uploaded.structuredContent.resource_id));
	const renamedAttachment = await mcp.call('update_attachment', {
		id: uploaded.structuredContent.resource_id,
		filename: 'mcp-acceptance-renamed.md',
	});
	assert.equal(renamedAttachment.isError, false);
	assert.equal(renamedAttachment.structuredContent.filename, 'mcp-acceptance-renamed.md');
	assert.equal((await mcp.call('read_attachment', { id: uploaded.structuredContent.resource_id })).content[1].resource.blob, originalBytes.toString('base64'));
	const replacementBytes = Buffer.from([255, 200, 0, 42]);
	const replacedAttachment = await mcp.call('update_attachment', {
		id: uploaded.structuredContent.resource_id,
		content_base64: replacementBytes.toString('base64'),
	});
	assert.equal(replacedAttachment.isError, false);
	assert.equal(replacedAttachment.structuredContent.size, replacementBytes.length);
	assert.equal((await mcp.call('read_attachment', { id: uploaded.structuredContent.resource_id })).content[1].resource.blob, replacementBytes.toString('base64'));
	const extensionlessName = 'mcp-acceptance-extensionless';
	const extensionlessBytes = Buffer.from([0, 255, 19, 128, 42]);
	const extensionless = await mcp.call('create_attachment', {
		filename: extensionlessName,
		content_base64: extensionlessBytes.toString('base64'),
		mime: 'application/pdf',
	});
	assert.equal(extensionless.isError, false);
	assert.equal(extensionless.structuredContent.file_extension, '');
	assert.equal(extensionless.structuredContent.filename, extensionlessName);
	const extensionlessRead = await mcp.call('read_attachment', { id: extensionless.structuredContent.resource_id });
	assert.equal(extensionlessRead.isError, false);
	assert.equal(extensionlessRead.structuredContent.file_extension, '');
	assert.equal(extensionlessRead.structuredContent.filename, extensionlessName);
	assert.equal(extensionlessRead.structuredContent.mime, 'application/pdf');
	assert.equal(extensionlessRead.content[1].resource.mimeType, 'application/pdf');
	assert.equal(extensionlessRead.content[1].resource.blob, extensionlessBytes.toString('base64'));
	const mimeUpdated = await mcp.call('update_attachment', {
		id: extensionless.structuredContent.resource_id,
		mime: 'text/plain',
	});
	assert.equal(mimeUpdated.isError, false);
	assert.equal(mimeUpdated.structuredContent.file_extension, '');
	assert.equal(mimeUpdated.structuredContent.filename, extensionlessName);
	assert.equal(mimeUpdated.structuredContent.mime, 'text/plain');
	const mimeUpdatedRead = await mcp.call('read_attachment', { id: extensionless.structuredContent.resource_id });
	assert.equal(mimeUpdatedRead.isError, false);
	assert.equal(mimeUpdatedRead.structuredContent.file_extension, '');
	assert.equal(mimeUpdatedRead.structuredContent.filename, extensionlessName);
	assert.equal(mimeUpdatedRead.structuredContent.mime, 'text/plain');
	assert.equal(mimeUpdatedRead.content[1].resource.mimeType, 'text/plain');
	assert.equal(mimeUpdatedRead.content[1].resource.blob, extensionlessBytes.toString('base64'));
	const extensionlessRenamedName = `${extensionlessName}.md`;
	const extensionlessRenamed = await mcp.call('update_attachment', {
		id: extensionless.structuredContent.resource_id,
		filename: extensionlessRenamedName,
	});
	assert.equal(extensionlessRenamed.isError, false);
	assert.equal(extensionlessRenamed.structuredContent.filename, extensionlessRenamedName);
	assert.equal(extensionlessRenamed.structuredContent.file_extension, 'md');
	assert.equal(extensionlessRenamed.structuredContent.mime, 'text/plain');
	const extensionlessRenamedRead = await mcp.call('read_attachment', { id: extensionless.structuredContent.resource_id });
	assert.equal(extensionlessRenamedRead.isError, false);
	assert.equal(extensionlessRenamedRead.structuredContent.filename, extensionlessRenamedName);
	assert.equal(extensionlessRenamedRead.structuredContent.mime, 'text/plain');
	assert.equal(extensionlessRenamedRead.content[1].resource.mimeType, 'text/plain');
	assert.equal(extensionlessRenamedRead.content[1].resource.blob, extensionlessBytes.toString('base64'));

	await until(async () => (await mcp.call('search_notes', { query: marker })).structuredContent.results.some(n => n.id === noteId), 'MCP change not in real FTS');
	assert.equal((await mcp.call('search_notes', { query: marker, mode: 'semantic' })).structuredContent.semantic.state, 'unavailable');
	t.diagnostic('PASS MCP initialization, revision history/conflicts, maintenance, attachments and FTS through actual encrypted core');
	await until(() => fs.existsSync(path.join(syncPath, `${noteId}.md`)), 'MCP change did not synchronize autonomously');
	const synchronized = fs.readFileSync(path.join(syncPath, `${noteId}.md`), 'utf8');
	assert.ok(synchronized.includes('encryption_applied: 1')); assert.ok(!synchronized.includes(marker));
	// Normal storage/client mode of the same binary, not a separately built unmodified upstream client.
	await command(['config', '--import'], JSON.stringify({ 'sync.target': 2, 'sync.2.path': syncPath, 'encryption.masterPassword': password }), false);
	await command(['sync'], '', false); await command(['e2ee', 'decrypt', '--force'], '', false);
	assert.ok((await command(['cat', noteId], '', false)).includes(`${marker} revised`));
	assert.equal(daemon.exitCode, null);
	t.diagnostic('PASS MCP-written note automatically E2EE-synced over filesystem and read by normal-mode client');
	await mcp.close();
	conf.allowWrites = false; fs.writeFileSync(configFile, JSON.stringify(conf));
	const reader = new StdioTestClient(configFile); t.after(() => reader.close()); await reader.initialize();
	assert.equal((await reader.request('tools/list')).tools.length, 19);
	await assert.rejects(reader.call('create_note', { parentId: notebook.id, title: 'blocked', body: '' }), { rpcCode: -32602 });
	assert.equal((await reader.call('get_note', { id: noteId, accountId: 'other' })).isError, true);
	await reader.close(); await stop(daemon); assert.equal(daemon.exitCode, 0);
	assert.ok(!fs.readFileSync(path.join(profile, 'database.sqlite')).includes(Buffer.from(marker)));
	const restarted = start(['serve']); await until(() => restarted.out.includes('headless: private API ready'), 'restart API unready');
	const again = new StdioTestClient(configFile); t.after(() => again.close()); await again.initialize();
	assert.equal((await again.call('get_note', { id: noteId })).structuredContent.body, `${marker} revised 😀\n${uploaded.structuredContent.markdown_link}`);
	await again.close(); await stop(restarted); assert.equal(restarted.exitCode, 0);
	t.diagnostic('PASS read-only enforcement, account-argument rejection and encrypted-core restart persistence');
});
