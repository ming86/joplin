import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRegistry } from '../index.mjs';
import { createMcpSession } from '../mcp.mjs';
import { account, backend, folderId, note, noteId, readJson, server } from './fixtures.mjs';

const movedNotebookId = 'c'.repeat(32);
const workTagId = 'd'.repeat(32);
const oldTagId = 'e'.repeat(32);
const newTagId = 'f'.repeat(32);
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initialize = () => request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity-test', version: '1' } });
const call = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });

function createSession(customBackend = backend(), config = account(), options = { allowWrites: true }) {
	const service = createAccountRegistry([config], { makeBackend: () => customBackend }).forPrincipal(config.id, config.id);
	return createMcpSession(service, options);
}

async function ready(session) {
	await session.handle(initialize());
	await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function invoke(session, name, args = {}, id = 2) {
	const response = await session.handle(call(id, name, args));
	assert.equal(response.error, undefined, `${name} should return a tool result`);
	return response.result;
}

function assertToolError(result, code) {
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.error.code, code);
}

test('Desktop read tools expose rich metadata and return full bodies by default with UTF-16-safe slices', async () => {
	const b = backend();
	const body = `${'a'.repeat(69999)}😀tail`;
	b.getNote = async () => ({ ...note, body, is_todo: 1, todo_completed: 1234 });
	b.getNotebook = async () => ({ id: folderId, title: 'Research' });
	b.getNoteTags = async () => [{ id: workTagId, title: 'Work' }, { id: oldTagId, title: 'Pinned' }];
	const session = createSession(b, account(), { allowWrites: false });
	await ready(session);
	try {
		const result = (await invoke(session, 'read_note', { id: noteId })).structuredContent;
		assert.equal(result.notebook_title, 'Research');
		assert.deepEqual(result.tags, ['Work', 'Pinned']);
		assert.equal(result.is_todo, true);
		assert.equal(result.todo_completed, true);
		assert.equal(result.created_time, note.created_time);
		assert.equal(result.updated_time, note.updated_time);
		assert.equal(result.body_length, body.length);
		assert.equal(result.body_offset, 0);
		assert.equal(result.body, body, 'the default read returns the full remaining body');
		assert.equal(result.body_returned_chars, body.length);
		assert.equal(result.has_more, false);
		assert.equal(result.nextOffset, null);
		assert.equal(result.body.endsWith('tail'), true);
		const zeroLength = (await invoke(session, 'read_note', { id: noteId, max_chars: 0 }, 3)).structuredContent;
		assert.equal(zeroLength.body, body, 'max_chars: 0 returns the full remaining body');

		const positiveLength = (await invoke(session, 'read_note', { id: noteId, max_chars: 70000 }, 4)).structuredContent;
		assert.equal(positiveLength.body_returned_chars, 70001, 'one extra code unit completes the surrogate pair');
		assert.equal(positiveLength.body.endsWith('😀'), true);
		assert.equal(positiveLength.has_more, true);
		assert.equal(positiveLength.nextOffset, 70001);

		const legacy = (await invoke(session, 'get_note', { id: noteId, offset: 0, length: 70000 }, 5)).structuredContent;
		assert.equal(legacy.body.length, 70001, 'the positive legacy length alias has no former 65536 ceiling');
		assert.equal(legacy.notebook_title, 'Research');

		const largeOffset = (await invoke(session, 'read_note', { id: noteId, offset: 128 * 1024 * 1024 + 1 }, 6)).structuredContent;
		assert.equal(largeOffset.body, '');
		assert.equal(largeOffset.body_offset, body.length);
	} finally { session.close(); }
});

test('MCP note, search, and tag fields accept values beyond the former arbitrary size limits', async () => {
	const b = backend();
	const title = 't'.repeat(1025);
	const longBody = 'b'.repeat(131073);
	const find = 'f'.repeat(131073);
	const replace = 'r'.repeat(131073);
	const query = 'q'.repeat(10001);
	const longTag = 'g'.repeat(257);
	let created;
	let update;
	let searched;
	b.createNote = async input => {
		created = input;
		return { ...note, title: input.title, body: input.body, parent_id: input.parentId, is_todo: input.is_todo };
	};
	b.getNote = async () => ({ ...note, body: find });
	b.updateNote = async (_id, input) => { update = input; return { ...note, ...input }; };
	b.search = async value => { searched = value; return { items: [{ ...note, body: 'match' }], hasMore: false }; };
	b.countSearchResults = async () => 1;
	b.createTag = async tagTitle => ({ id: tagTitle.length.toString(16).padStart(32, '0'), title: tagTitle });
	b.addTagToNote = async () => {};
	b.getNoteTags = async () => [];
	const session = createSession(b);
	await ready(session);
	try {
		const createdResult = await invoke(session, 'create_note', { title, body: longBody, notebook_id: folderId });
		assert.equal(createdResult.isError, false);
		assert.equal(created.title.length, 1025);
		assert.equal(created.body.length, 131073);

		const updatedResult = await invoke(session, 'update_note', { id: noteId, replace_text: { find, replace } }, 3);
		assert.equal(updatedResult.isError, false);
		assert.equal(update.body, replace);

		const searchResult = await invoke(session, 'search_notes', { query }, 4);
		assert.equal(searchResult.isError, false);
		assert.equal(searched, query);

		const tags = Array.from({ length: 101 }, (_, index) => `Tag ${index}`);
		tags[0] = longTag;
		const tagResult = await invoke(session, 'manage_tags', { note_id: noteId, add: tags }, 5);
		assert.equal(tagResult.isError, false);
		assert.equal(tagResult.structuredContent.added.length, 101);
		assert.equal(tagResult.structuredContent.added[0].length, 257);
	} finally { session.close(); }
});

test('Desktop update operations compose, replace only unique text, move notebooks, and toggle to-dos', async () => {
	const b = backend();
	let current = { ...note, body: 'middle' };
	const patches = [];
	b.getNote = async () => current;
	b.updateNote = async (_id, patch) => {
		patches.push(patch);
		current = { ...current, ...patch, parent_id: patch.parentId ?? current.parent_id };
		return current;
	};
	const session = createSession(b);
	await ready(session);
	try {
		await invoke(session, 'update_note', { id: noteId, prepend: 'start ', append: ' end' });
		assert.equal(patches[0].body, 'start middle end');

		await invoke(session, 'update_note', { id: noteId, replace_text: { find: 'middle', replace: 'center' } }, 3);
		assert.equal(patches[1].body, 'start center end');
		assertToolError(await invoke(session, 'update_note', { id: noteId, replace_text: { find: 'missing', replace: 'x' } }, 4), 'replace_text_not_found');
		current = { ...current, body: 'same and same' };
		assertToolError(await invoke(session, 'update_note', { id: noteId, replace_text: { find: 'same', replace: 'x' } }, 5), 'replace_text_ambiguous');
		assert.equal(patches.length, 2, 'failed replacements do not write');

		await invoke(session, 'update_note', { id: noteId, notebook_id: movedNotebookId, todo_completed: true }, 6);
		assert.equal(patches[2].parentId, movedNotebookId);
		assert.ok(patches[2].todo_completed > 0);
		await invoke(session, 'update_note', { id: noteId, todo_completed: false }, 7);
		assert.equal(patches[3].todo_completed, 0);
	} finally { session.close(); }
});

test('account service keeps configured and sole notebook defaults outside the MCP tool', async () => {
	const singleNotebook = backend();
	const createdInputs = [];
	singleNotebook.createNote = async input => {
		createdInputs.push(input);
		return { ...note, title: input.title, body: input.body, parent_id: input.parentId, is_todo: input.is_todo };
	};
	const soleConfig = account();
	const first = createAccountRegistry([soleConfig], { makeBackend: () => singleNotebook }).forPrincipal(soleConfig.id, soleConfig.id);
	const created = await first.createNote({ title: 'Title only', is_todo: true });
	assert.equal(createdInputs[0].body, '');
	assert.equal(createdInputs[0].parentId, folderId);
	assert.equal(createdInputs[0].is_todo, 1);
	assert.equal(created.notebook_id, folderId);

	const configured = backend();
	const config = account(); config.defaultNotebookId = movedNotebookId;
	configured.listNotebooks = async () => ({ items: [{ id: folderId, title: 'A' }, { id: movedNotebookId, title: 'B' }], hasMore: false });
	configured.createNote = async input => {
		createdInputs.push(input);
		return { ...note, title: input.title, body: input.body, parent_id: input.parentId, is_todo: input.is_todo };
	};
	const second = createAccountRegistry([config], { makeBackend: () => configured }).forPrincipal(config.id, config.id);
	await second.createNote({ title: 'Default notebook' });
	assert.equal(createdInputs[1].parentId, movedNotebookId);
	assert.equal(createdInputs[1].is_todo, 0);
});

test('notebook counts, notebook creation, tag listing, and case-insensitive tag changes use eligible notes', async () => {
	const b = backend();
	const childNotebookId = movedNotebookId;
	const tags = [{ id: workTagId, title: 'Work' }, { id: oldTagId, title: 'Old' }];
	let assigned = [tags[0], tags[1]];
	const summaries = [
		{ ...note, parent_id: folderId },
		{ ...note, id: '1'.repeat(32), parent_id: folderId },
		{ ...note, id: '2'.repeat(32), parent_id: folderId, encryption_applied: 1 },
		{ ...note, id: '3'.repeat(32), parent_id: folderId, deleted_time: 9 },
		{ ...note, id: '4'.repeat(32), parent_id: childNotebookId },
	];
	b.listAllNotebooks = async () => [
		{ id: folderId, title: 'Main', parent_id: null },
		{ id: childNotebookId, title: 'Child', parent_id: folderId },
	];
	b.listNoteSummaries = async () => ({ items: summaries, hasMore: false });
	b.listAllTags = async () => tags;
	b.getNoteTags = async () => assigned;
	b.createTag = async title => { const tag = { id: newTagId, title }; tags.push(tag); return tag; };
	b.addTagToNote = async tagId => { const tag = tags.find(item => item.id === tagId); if (!assigned.some(item => item.id === tagId)) assigned = [...assigned, tag]; };
	b.removeTagFromNote = async tagId => { assigned = assigned.filter(item => item.id !== tagId); };
	b.createNotebook = async ({ title, parentId }) => ({ id: childNotebookId, title, parent_id: parentId ?? null });
	const session = createSession(b);
	await ready(session);
	try {
		const notebooks = (await invoke(session, 'list_notebooks')).structuredContent.notebooks;
		assert.deepEqual(notebooks.map(({ id, note_count }) => [id, note_count]), [[folderId, 2], [childNotebookId, 1]]);

		const createdNotebook = (await invoke(session, 'create_notebook', { title: ' Nested ', parent_id: folderId }, 3)).structuredContent;
		assert.equal(createdNotebook.id, childNotebookId);
		assert.equal(createdNotebook.title, 'Nested');

		const listedTags = (await invoke(session, 'list_tags', {}, 4)).structuredContent.tags;
		assert.deepEqual(listedTags.map(tag => tag.title), ['Work', 'Old']);
		const changed = (await invoke(session, 'manage_tags', { note_id: noteId, add: [' work ', ' New '], remove: ['OLD'] }, 5)).structuredContent;
		assert.deepEqual(changed.added, ['work', 'New']);
		assert.deepEqual(changed.removed, ['OLD']);
		assert.deepEqual(changed.tags, ['Work', 'New']);
	} finally { session.close(); }
});

test('MCP write catalog carries mutation annotations and rejects unsafe note states', async () => {
	const readonly = createSession(backend(), account(), { allowWrites: false });
	await ready(readonly);
	try {
		const tools = (await readonly.handle(request(2, 'tools/list'))).result.tools;
		const names = new Set(tools.map(tool => tool.name));
		for (const name of ['get_status', 'list_notebooks', 'list_notes', 'search_notes', 'semantic_search_notes', 'read_note', 'get_note', 'list_tags']) assert.ok(names.has(name), name);
		for (const name of ['create_note', 'update_note', 'delete_note', 'create_notebook', 'manage_tags']) assert.ok(!names.has(name), name);
	} finally { readonly.close(); }

	const writable = createSession();
	await ready(writable);
	try {
		const tools = (await writable.handle(request(2, 'tools/list'))).result.tools;
		const byName = new Map(tools.map(tool => [tool.name, tool]));
		assert.equal(byName.get('update_note').annotations.destructiveHint, true);
		assert.equal(byName.get('delete_note').annotations.destructiveHint, true);
		assert.equal(byName.get('delete_note').annotations.idempotentHint, true);
		assert.equal(byName.get('create_notebook').annotations.readOnlyHint, false);
		assert.equal(byName.get('manage_tags').annotations.readOnlyHint, false);
	} finally { writable.close(); }

	for (const unsafe of [{ encryption_applied: 1 }, { is_locked: 1 }, { deleted_time: 1 }]) {
		const b = backend();
		b.getNote = async () => ({ ...note, ...unsafe });
		let mutations = 0;
		b.updateNote = b.deleteNote = b.createTag = b.addTagToNote = b.removeTagFromNote = async () => { mutations++; };
		const session = createSession(b);
		await ready(session);
		try {
			assertToolError(await invoke(session, 'update_note', { id: noteId, title: 'Blocked' }), 'note_unavailable');
			assertToolError(await invoke(session, 'delete_note', { id: noteId }, 3), 'note_unavailable');
			assertToolError(await invoke(session, 'manage_tags', { note_id: noteId, add: ['Tag'] }, 4), 'note_unavailable');
			assert.equal(mutations, 0);
		} finally { session.close(); }
	}
});

test('real Data API writes keep Markdown out of POST, preserve unknown PUT outcomes, and soft-delete', async t => {
	let postBodies = 0; let putBodies = 0; let failPut = false; let deleteQuery;
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://localhost');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		res.setHeader('Content-Type', 'application/json');
		if (req.method === 'GET' && target.pathname === `/folders/${folderId}`) {
			return res.end(JSON.stringify({ id: folderId, title: 'Notebook', parent_id: '', encryption_applied: 0, deleted_time: 0 }));
		}
		if (req.method === 'GET' && target.pathname === `/notes/${noteId}`) return res.end(JSON.stringify(note));
		if (req.method === 'POST' && target.pathname === '/notes') {
			const body = await readJson(req);
			postBodies++;
			assert.equal(body.body, '', 'POST must not include user Markdown that Joplin could scan for media URLs');
			return res.end(JSON.stringify({ id: noteId }));
		}
		if (req.method === 'PUT' && target.pathname === `/notes/${noteId}`) {
			const body = await readJson(req);
			putBodies++;
			assert.deepEqual(body, { body: '![remote](http://example.invalid/image.png)' });
			if (failPut) { res.writeHead(500); return res.end('private server text'); }
			return res.end(JSON.stringify({ ...note, title: 'Created', body: body.body }));
		}
		if (req.method === 'DELETE' && target.pathname === `/notes/${noteId}`) {
			deleteQuery = target.searchParams;
			return res.end();
		}
		res.writeHead(404); return res.end('{}');
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal(config.id, config.id);
	const session = createMcpSession(service, { allowWrites: true });
	await ready(session);
	try {
		const markdown = '![remote](http://example.invalid/image.png)';
		const created = (await invoke(session, 'create_note', { title: 'Created', body: markdown, notebook_id: folderId })).structuredContent;
		assert.equal(created.saved, 'local');
		assert.equal(postBodies, 1);
		assert.equal(putBodies, 1);

		failPut = true;
		const uncertain = await invoke(session, 'create_note', { title: 'Uncertain', body: markdown, notebook_id: folderId }, 3);
		assertToolError(uncertain, 'write_outcome_unknown');
		assert.equal(uncertain.structuredContent.error.outcomeUnknown, true);
		assert.equal(postBodies, 2);
		assert.equal(putBodies, 2, 'the failed second PUT is not retried');

		const deleted = (await invoke(session, 'delete_note', { id: noteId }, 4)).structuredContent;
		assert.equal(deleted.trashed, true);
		assert.equal(deleteQuery.has('permanent'), false, 'DELETE uses Joplin Trash semantics');
	} finally { session.close(); }
});

test('MCP updates preserve HTML note bodies and format for metadata and raw-body operations', async t => {
	const originalBody = '<article><h1>Heading</h1><p>Old text</p></article>';
	let currentNote = { ...note, body: originalBody, markup_language: 2, is_todo: 1 };
	const putBodies = [];
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://localhost');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		res.setHeader('Content-Type', 'application/json');
		if (req.method === 'GET' && target.pathname === `/notes/${noteId}`) return res.end(JSON.stringify(currentNote));
		if (req.method === 'GET' && target.pathname === `/folders/${movedNotebookId}`) {
			return res.end(JSON.stringify({ id: movedNotebookId, title: 'Moved notebook', parent_id: '', encryption_applied: 0, deleted_time: 0 }));
		}
		if (req.method === 'PUT' && target.pathname === `/notes/${noteId}`) {
			const body = await readJson(req);
			putBodies.push(body);
			currentNote = {
				...currentNote,
				...body,
				parent_id: body.parent_id ?? currentNote.parent_id,
				updated_time: currentNote.updated_time + 1,
			};
			return res.end(JSON.stringify(currentNote));
		}
		res.writeHead(404);
		return res.end('{}');
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal(config.id, config.id);
	const session = createMcpSession(service, { allowWrites: true });
	await ready(session);
	try {
		const metadataResult = await invoke(session, 'update_note', {
			id: noteId, title: 'Renamed HTML note', notebook_id: movedNotebookId, todo_completed: true,
		});
		assert.equal(metadataResult.isError, false);
		assert.deepEqual(Object.keys(putBodies[0]).sort(), ['parent_id', 'title', 'todo_completed']);
		assert.equal(putBodies[0].title, 'Renamed HTML note');
		assert.equal(putBodies[0].parent_id, movedNotebookId);
		assert.ok(putBodies[0].todo_completed > 0);
		assert.equal(currentNote.body, originalBody);
		assert.equal(currentNote.markup_language, 2);
		assert.equal(metadataResult.structuredContent.note.body, originalBody);
		assert.equal(metadataResult.structuredContent.note.markup_language, 2);

		const replacement = '<article><h1>Updated</h1><p>Old text</p></article>';
		const replaceResult = await invoke(session, 'update_note', { id: noteId, body: replacement }, 3);
		assert.equal(replaceResult.isError, false);
		assert.deepEqual(putBodies[1], { body: replacement });
		assert.equal(currentNote.body, replacement);
		assert.equal(currentNote.markup_language, 2);

		const expectedBody = '<!-- start --><article><h1>Updated</h1><p>New text</p></article><!-- end -->';
		const partialResult = await invoke(session, 'update_note', {
			id: noteId,
			prepend: '<!-- start -->',
			append: '<!-- end -->',
			replace_text: { find: 'Old text', replace: 'New text' },
		}, 4);
		assert.equal(partialResult.isError, false);
		assert.deepEqual(putBodies[2], { body: expectedBody });
		assert.equal(currentNote.body, expectedBody);
		assert.equal(currentNote.markup_language, 2);
		assert.equal(partialResult.structuredContent.note.markup_language, 2);
	} finally { session.close(); }
});

test('MCP reports structured core validation messages and keeps other 400 responses definite', async t => {
	let failure = 'validation';
	let writes = 0;
	const validationMessage = 'The note title is invalid.';
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://localhost');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		if (req.method === 'GET' && target.pathname === `/folders/${folderId}`) {
			return res.end(JSON.stringify({ id: folderId, title: 'Notebook', parent_id: '', encryption_applied: 0, deleted_time: 0 }));
		}
		if (req.method === 'GET' && target.pathname === `/notes/${noteId}`) return res.end(JSON.stringify(note));
		if (req.method === 'POST' && target.pathname === '/notes') {
			await readJson(req);
			writes++;
			res.writeHead(400, { 'Content-Type': 'application/json' });
			if (failure === 'validation') return res.end(JSON.stringify({ code: 'validation_error', error: validationMessage, stack: 'private stack' }));
			if (failure === 'generic') return res.end(JSON.stringify({ error: 'private upstream text' }));
			return res.end('{ malformed');
		}
		if (req.method === 'PUT' && target.pathname === `/notes/${noteId}`) {
			assert.deepEqual(await readJson(req), { title: 'Rejected update' });
			writes++;
			res.writeHead(400, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ code: 'validation_error', error: 'The note update is invalid.', stack: 'private update stack' }));
		}
		res.writeHead(404);
		return res.end('{}');
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal(config.id, config.id);
	const session = createMcpSession(service, { allowWrites: true });
	await ready(session);
	try {
		const args = { title: 'Rejected note', body: '', notebook_id: folderId };
		const validation = (await invoke(session, 'create_note', args)).structuredContent.error;
		assert.deepEqual(validation, { code: 'validation_error', message: validationMessage, outcomeUnknown: false });
		assert.equal(JSON.stringify(validation).includes('private stack'), false);

		const update = (await invoke(session, 'update_note', { id: noteId, title: 'Rejected update' }, 3)).structuredContent.error;
		assert.deepEqual(update, { code: 'validation_error', message: 'The note update is invalid.', outcomeUnknown: false });
		assert.equal(JSON.stringify(update).includes('private update stack'), false);

		failure = 'generic';
		const generic = (await invoke(session, 'create_note', args, 4)).structuredContent.error;
		assert.deepEqual(generic, { code: 'backend_request_failed', outcomeUnknown: false });
		assert.equal(JSON.stringify(generic).includes('private upstream text'), false);

		failure = 'malformed';
		const malformed = (await invoke(session, 'create_note', args, 5)).structuredContent.error;
		assert.deepEqual(malformed, { code: 'backend_request_failed', outcomeUnknown: false });
		assert.equal(writes, 4);
	} finally { session.close(); }
});

test('real Data API notebook and tag scans page through results and omit unavailable entries', async t => {
	const folderPages = []; const tagPages = [];
	const secondFolderId = '1'.repeat(32);
	const encryptedFolderId = '2'.repeat(32);
	const deletedFolderId = '3'.repeat(32);
	const encryptedTagId = '4'.repeat(32);
	const unknownTagId = '5'.repeat(32);
	const safeTagId = '6'.repeat(32);
	const secondTagId = '7'.repeat(32);
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://localhost');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		res.setHeader('Content-Type', 'application/json');
		if (req.method === 'GET' && target.pathname === '/folders') {
			const page = Number(target.searchParams.get('page'));
			folderPages.push(page);
			const items = page === 1
				? [
					{ id: folderId, title: 'Visible', parent_id: '', encryption_applied: 0, deleted_time: 0 },
					{ id: encryptedFolderId, title: 'Encrypted', parent_id: '', encryption_applied: 1, deleted_time: 0 },
				]
				: [
					{ id: deletedFolderId, title: 'Deleted', parent_id: '', encryption_applied: 0, deleted_time: 10 },
					{ id: secondFolderId, title: 'Second', parent_id: '', encryption_applied: 0, deleted_time: 0 },
				];
			return res.end(JSON.stringify({ items, has_more: page === 1 }));
		}
		if (req.method === 'GET' && target.pathname === '/notes') {
			const items = [
				{ ...note, parent_id: folderId },
				{ ...note, id: '8'.repeat(32), parent_id: folderId, encryption_applied: 1 },
				{ ...note, id: '9'.repeat(32), parent_id: folderId, is_locked: 1 },
				{ ...note, id: 'a'.repeat(32), parent_id: secondFolderId },
			];
			return res.end(JSON.stringify({ items, has_more: false }));
		}
		if (req.method === 'GET' && target.pathname === '/tags') {
			const page = Number(target.searchParams.get('page'));
			tagPages.push(page);
			const items = page === 1
				? [
					{ id: safeTagId, title: 'Visible tag', encryption_applied: 0 },
					{ id: encryptedTagId, title: 'Encrypted tag', encryption_applied: 1 },
				]
				: [
					{ id: unknownTagId, title: 'Unknown state' },
					{ id: secondTagId, title: 'Second tag', encryption_applied: 0 },
				];
			return res.end(JSON.stringify({ items, has_more: page === 1 }));
		}
		res.writeHead(404); return res.end('{}');
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal(config.id, config.id);
	const session = createMcpSession(service);
	await ready(session);
	try {
		const notebooks = (await invoke(session, 'list_notebooks')).structuredContent.notebooks;
		assert.deepEqual(notebooks.map(item => [item.id, item.title, item.note_count]), [[folderId, 'Visible', 1], [secondFolderId, 'Second', 1]]);
		const tags = (await invoke(session, 'list_tags', {}, 3)).structuredContent.tags;
		assert.deepEqual(tags, [{ id: safeTagId, title: 'Visible tag' }, { id: secondTagId, title: 'Second tag' }]);
		assert.deepEqual(folderPages, [1, 2]);
		assert.deepEqual(tagPages, [1, 2]);
	} finally { session.close(); }
});

test('keyword search returns an exact eligible total without changing the requested result page', async t => {
	const metadataPages = [];
	let requestedPage;
	const safeOne = { id: '1'.repeat(32), encryption_applied: 0, deleted_time: 0, is_locked: 0 };
	const encrypted = { id: '2'.repeat(32), encryption_applied: 1, deleted_time: 0, is_locked: 0 };
	const deleted = { id: '3'.repeat(32), encryption_applied: 0, deleted_time: 42, is_locked: 0 };
	const locked = { id: '4'.repeat(32), encryption_applied: 0, deleted_time: 0, is_locked: 1 };
	const safeTwo = { id: '5'.repeat(32), encryption_applied: 0, deleted_time: 0, is_locked: 0 };
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://localhost');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		assert.equal(req.method, 'GET');
		const requestBody = [];
		for await (const chunk of req) requestBody.push(chunk);
		assert.equal(Buffer.concat(requestBody).length, 0, 'search requests carry no HTTP body');
		res.setHeader('Content-Type', 'application/json');
		assert.equal(target.pathname, '/search');
		if (target.searchParams.get('fields') === 'id,encryption_applied,deleted_time,is_locked') {
			const page = Number(target.searchParams.get('page'));
			metadataPages.push({ page, fields: target.searchParams.get('fields') });
			const items = page === 1 ? [safeOne, encrypted, deleted, locked] : [safeTwo];
			return res.end(JSON.stringify({ items, has_more: page === 1 }));
		}
		requestedPage = {
			page: Number(target.searchParams.get('page')),
			limit: Number(target.searchParams.get('limit')),
			fields: target.searchParams.get('fields'),
		};
		return res.end(JSON.stringify({
			items: [{ ...note, id: safeTwo.id, title: 'Requested page', body: 'needle in this result' }],
			has_more: true,
		}));
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal(config.id, config.id);
	const session = createMcpSession(service);
	await ready(session);
	try {
		const result = (await invoke(session, 'search_notes', { query: 'needle', page: 2, limit: 1 })).structuredContent;
		assert.equal(result.total, 2, 'the total counts readable matches from every metadata page');
		assert.deepEqual(result.results.map(item => item.id), [safeTwo.id], 'results remain limited to the requested search page');
		assert.deepEqual(result.items.map(item => item.id), [safeTwo.id]);
		assert.equal(result.hasMore, true);
		assert.deepEqual(metadataPages, [
			{ page: 1, fields: 'id,encryption_applied,deleted_time,is_locked' },
			{ page: 2, fields: 'id,encryption_applied,deleted_time,is_locked' },
		]);
		assert.deepEqual(requestedPage, { page: 2, limit: 1, fields: 'id,parent_id,title,body,created_time,updated_time,is_todo,todo_completed,markup_language,encryption_applied,deleted_time,is_locked' });
		assert.ok(metadataPages.every(({ fields }) => !fields.split(',').includes('body')));
	} finally { session.close(); }
});

test('real Data API tag associations accept empty success and continue duplicate, create, and remove operations', async t => {
	const existingTag = { id: workTagId, title: 'Already attached', encryption_applied: 0 };
	const removedTag = { id: oldTagId, title: 'Remove me', encryption_applied: 0 };
	const tags = [existingTag, removedTag];
	let assigned = [existingTag, removedTag];
	let emptyCreateResponse = false;
	const associations = [];
	const removals = [];
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://localhost');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		res.setHeader('Content-Type', 'application/json');
		if (req.method === 'GET' && target.pathname === `/notes/${noteId}`) return res.end(JSON.stringify(note));
		if (req.method === 'GET' && target.pathname === '/tags') return res.end(JSON.stringify({ items: tags, has_more: false }));
		if (req.method === 'GET' && target.pathname === `/notes/${noteId}/tags`) {
			return res.end(JSON.stringify({ items: assigned, has_more: false }));
		}
		if (req.method === 'POST' && target.pathname === '/tags') {
			const body = await readJson(req);
			if (emptyCreateResponse) return res.end();
			const tag = { id: newTagId, title: body.title, encryption_applied: 0 };
			tags.push(tag);
			return res.end(JSON.stringify(tag));
		}
		const association = target.pathname.match(/^\/tags\/([a-f0-9]{32})\/notes$/);
		if (req.method === 'POST' && association) {
			const body = await readJson(req);
			assert.equal(body.id, noteId);
			associations.push(association[1]);
			const tag = tags.find(item => item.id === association[1]);
			if (!assigned.some(item => item.id === tag.id)) assigned = [...assigned, tag];
			return res.end(); // Joplin returns an empty 200 for an idempotent association.
		}
		const removal = target.pathname.match(/^\/tags\/([a-f0-9]{32})\/notes\/([a-f0-9]{32})$/);
		if (req.method === 'DELETE' && removal) {
			removals.push(removal[1]);
			assigned = assigned.filter(item => item.id !== removal[1]);
			return res.end();
		}
		res.writeHead(404); return res.end('{}');
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal(config.id, config.id);
	const session = createMcpSession(service, { allowWrites: true });
	await ready(session);
	try {
		const result = (await invoke(session, 'manage_tags', {
			note_id: noteId,
			add: ['Already attached', 'New tag', 'New tag'],
			remove: ['Remove me'],
		})).structuredContent;
		assert.deepEqual(associations, [workTagId, newTagId, newTagId]);
		assert.deepEqual(removals, [oldTagId], 'the removal still runs after empty association responses');
		assert.deepEqual(result.added, ['Already attached', 'New tag', 'New tag']);
		assert.deepEqual(result.removed, ['Remove me']);
		assert.deepEqual(result.tags, ['Already attached', 'New tag']);

		emptyCreateResponse = true;
		const failed = await invoke(session, 'manage_tags', { note_id: noteId, add: ['Tag with empty entity response'] }, 3);
		assertToolError(failed, 'write_outcome_unknown');
		assert.deepEqual(associations, [workTagId, newTagId, newTagId], 'an empty tag-creation entity is still an unknown write outcome');
		assert.deepEqual(removals, [oldTagId]);
	} finally { session.close(); }
});

test('notebook note counts include page 50 when the complete 5000-note page reports more', async () => {
	const b = backend();
	const pages = [];
	b.listAllNotebooks = async () => [{ id: folderId, title: 'Large notebook', parent_id: null }];
	b.listNoteSummaries = async ({ page, limit }) => {
		pages.push({ page, limit });
		const items = page <= 50
			? Array.from({ length: 100 }, (_, index) => ({
				...note,
				id: (page * 100 + index).toString(16).padStart(32, '0'),
				parent_id: folderId,
			}))
			: [];
		return { items, hasMore: page <= 50 };
	};
	const session = createSession(b, account(), { allowWrites: false });
	await ready(session);
	try {
		const notebooks = (await invoke(session, 'list_notebooks')).structuredContent.notebooks;
		assert.equal(notebooks[0].note_count, 5000);
		assert.deepEqual(pages[49], { page: 50, limit: 100 });
		assert.deepEqual(pages[50], { page: 51, limit: 100 });
		assert.equal(pages.length, 51, 'the empty final page ends the scan after the full 5000-note page');
	} finally { session.close(); }
});

test('account service fallback scans past filtered notebooks and rejects multiple readable choices', async t => {
	const encryptedId = '1'.repeat(32);
	const deletedId = '2'.repeat(32);
	const safeId = '3'.repeat(32);
	const secondSafeId = '4'.repeat(32);
	let ambiguous = false;
	const folderPages = [];
	const createdBodies = [];
	const url = await server(t, async (req, res) => {
		const target = new URL(req.url, 'http://localhost');
		assert.equal(target.searchParams.get('token'), 'alice-private-token');
		res.setHeader('Content-Type', 'application/json');
		if (req.method === 'GET' && target.pathname === '/folders') {
			const page = Number(target.searchParams.get('page'));
			assert.equal(Number(target.searchParams.get('limit')), 2);
			folderPages.push({ page, ambiguous });
			if (ambiguous) {
				return res.end(JSON.stringify({ items: [
					{ id: safeId, title: 'First readable', parent_id: '', encryption_applied: 0, deleted_time: 0 },
					{ id: secondSafeId, title: 'Second readable', parent_id: '', encryption_applied: 0, deleted_time: 0 },
				], has_more: false }));
			}
			if (page === 1) {
				return res.end(JSON.stringify({ items: [
					{ id: encryptedId, title: 'Encrypted', parent_id: '', encryption_applied: 1, deleted_time: 0 },
					{ id: deletedId, title: 'Deleted', parent_id: '', encryption_applied: 0, deleted_time: 1 },
				], has_more: true }));
			}
			return res.end(JSON.stringify({ items: [
				{ id: safeId, title: 'Only readable', parent_id: '', encryption_applied: 0, deleted_time: 0 },
			], has_more: false }));
		}
		if (req.method === 'GET' && target.pathname === `/folders/${safeId}`) {
			return res.end(JSON.stringify({ id: safeId, title: 'Only readable', parent_id: '', encryption_applied: 0, deleted_time: 0 }));
		}
		if (req.method === 'POST' && target.pathname === '/notes') {
			const body = await readJson(req);
			createdBodies.push(body);
			return res.end(JSON.stringify({
				...note,
				parent_id: body.parent_id,
				title: body.title,
				body: body.body,
				is_todo: body.is_todo,
			}));
		}
		res.writeHead(404); return res.end('{}');
	});
	const config = account(); config.joplin.baseUrl = url;
	const service = createAccountRegistry([config]).forPrincipal(config.id, config.id);
	const created = await service.createNote({ title: 'Find the only readable notebook' });
	assert.equal(created.notebook_id, safeId);
	assert.equal(createdBodies[0].parent_id, safeId);
	assert.deepEqual(folderPages.slice(0, 2), [{ page: 1, ambiguous: false }, { page: 2, ambiguous: false }]);

	ambiguous = true;
	await assert.rejects(service.createNote({ title: 'Two readable notebooks' }), error => error.code === 'notebook_id_required');
	assert.equal(createdBodies.length, 1, 'ambiguous fallback does not create a note');
	assert.deepEqual(folderPages.at(-1), { page: 1, ambiguous: true });
});
