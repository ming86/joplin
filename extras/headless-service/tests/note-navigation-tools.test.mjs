import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/mcp/tools.mjs';
import { bodyTotalLineCount } from '../src/mcp/body-line-count.mjs';

/** Fixed synthetic native identities; no user profile is read by this suite. */
const noteId = 'a'.repeat(32);
const revisionId = 'b'.repeat(32);
/** Paging fields describe returned body text and must be absent from outlines. */
const pagingFields = ['body', 'body_offset', 'body_returned_chars', 'has_more', 'offset', 'nextOffset', 'offsetUnit', 'body_start_line', 'body_end_line'];

/** Build a catalog around an exact native snapshot and existing search result bodies. */
function fixture(body, extra = {}) {
	let reads = 0;
	let current = {
		id: noteId, accountId: 'private-binding', parent_id: 'c'.repeat(32), title: 'Navigation fixture',
		body, revision_id: revisionId, markup_language: 1, is_todo: 1, todo_completed: 1234,
		created_time: 1, updated_time: 2, ...extra,
	};
	const tools = createTools({
		async status() { return { accountEmail: 'alice@example.test' }; },
		async readNoteWithRevision(id) { assert.equal(id, noteId); reads++; return { ...current }; },
		async search({ mode = 'keyword' }) {
			return {
				accountId: 'private-binding', requestedMode: mode, executedMode: mode,
				semantic: { state: 'ready' }, hasMore: false,
				items: [{ ...current, provenance: mode }],
			};
		},
	});
	return {
		tools,
		read: (args = {}, name = 'read_note') => tools.call(name, { id: noteId, ...args }),
		set: values => { current = { ...current, ...values }; },
		reads: () => reads,
	};
}

/** Check that a successful read retains complete-source measurements and public identity. */
function assertSource(value, body, expectedRevision = revisionId) {
	assert.equal(value.revision_id, expectedRevision);
	assert.equal(value.body_length, body.length);
	assert.equal(value.totalLength, body.length);
	assert.equal(value.body_total_line_count, bodyTotalLineCount(body));
	assert.equal(value.accountEmail, 'alice@example.test');
	assert.equal(Object.hasOwn(value, 'accountId'), false);
}

test('outline and section reads retain native source coordinates, metadata, and independent revisions', async () => {
	const body = 'preamble\r\n# **Alpha**\r\nparent\r\n## Child\r\nchild 😀\r\n# Beta\r\nlast';
	const f = fixture(body, { body_size_bytes: 987, body_sha256: 'd'.repeat(64) });
	const outlineResult = await f.read({ outline: true });
	assert.equal(outlineResult.isError, false);
	const outline = outlineResult.structuredContent;
	assertSource(outline, body);
	assert.deepEqual(outline.outline.map(entry => [entry.path, entry.heading, entry.level]), [
		['0', '', 0], ['1', '**Alpha**', 1], ['1.1', 'Child', 2], ['2', 'Beta', 1],
	]);
	assert.equal(outline.body_size_bytes, 987, 'available native source measurements remain unchanged');
	assert.equal(outline.body_sha256, 'd'.repeat(64));
	for (const key of pagingFields) assert.equal(Object.hasOwn(outline, key), false, key);
	assert.equal(outline.outline[1].start_offset, body.indexOf('# **Alpha**'));
	assert.equal(outline.outline[1].end_offset, body.indexOf('# Beta'));
	assert.equal(outline.outline[1].start_line, 2);
	assert.equal(outline.outline[1].end_line, 5);
	const section = (await f.read({ section: ' **alpha** ' })).structuredContent;
	assertSource(section, body);
	assert.equal(section.body, body.slice(body.indexOf('# **Alpha**'), body.indexOf('# Beta')));
	assert.equal(section.section_path, '1');
	assert.equal(section.section_heading, '**Alpha**');
	assert.equal(section.section_start_offset, body.indexOf('# **Alpha**'));
	assert.equal(section.section_end_offset, body.indexOf('# Beta'));
	assert.equal(section.body_offset, section.section_start_offset);
	assert.equal(section.offset, section.body_offset);
	assert.equal(section.body_returned_chars, section.body.length);
	assert.equal(section.has_more, false);
	assert.equal(section.nextOffset, null);
	assert.equal(section.body_size_bytes, 987);
	assert.equal(section.body_sha256, 'd'.repeat(64));
	const preamble = (await f.read({ section: '0' })).structuredContent;
	assert.equal(preamble.body, 'preamble\r\n');
	assert.equal(preamble.section_heading, '');
	f.set({ revision_id: 'e'.repeat(32), body: '# Inserted\n' + body });
	const fresh = (await f.read({ section: '**Alpha**' })).structuredContent;
	assert.equal(fresh.revision_id, 'e'.repeat(32), 'each navigation call reads a new native snapshot');
	assert.equal(f.reads(), 4);
});

test('section paging clamps absolute offsets, keeps surrogate pairs, and preserves the legacy alias', async () => {
	const body = '# First\nshort\n# Target\nA😀B\n# Last\ntail';
	const f = fixture(body);
	const start = body.indexOf('# Target');
	const end = body.indexOf('# Last');
	const emoji = body.indexOf('😀');
	const before = (await f.read({ section: '2', offset: 0, max_chars: 1 })).structuredContent;
	assert.equal(before.body_offset, start);
	assert.equal(before.body, '#');
	assert.equal(before.nextOffset, start + 1);
	const split = (await f.read({ section: 'Target', offset: emoji + 1, max_chars: 1 })).structuredContent;
	assert.equal(split.body, '😀');
	assert.equal(split.body_offset, emoji);
	assert.equal(split.body_returned_chars, 2);
	assert.equal(split.nextOffset, emoji + 2);
	assert.equal(split.has_more, true);
	const continued = (await f.read({ section: 'Target', offset: split.nextOffset, max_chars: 0, length: 1 })).structuredContent;
	assert.equal(continued.body, body.slice(emoji + 2, end), 'explicit zero max_chars overrides legacy length');
	assert.equal(continued.nextOffset, null);
	assert.equal(continued.has_more, false);
	const past = (await f.read({ section: 'Target', offset: body.length + 100 })).structuredContent;
	assert.equal(past.body, '');
	assert.equal(past.offset, end);
	assert.equal(past.nextOffset, null);
	const legacy = (await f.read({ section: '2', length: 3 }, 'get_note')).structuredContent;
	assert.equal(legacy.body, '# T');
	assert.equal(legacy.offset, start);
	assert.equal(legacy.nextOffset, start + 3);
	assert.equal(legacy.is_todo, 1);
	assert.equal(legacy.todo_completed, 1234);
	assertSource(legacy, body);
	const large = '# Large\n' + 'x'.repeat(70000) + '\n# End\n';
	f.set({ body: large });
	const full = (await f.read({ section: 'Large' })).structuredContent;
	assert.equal(full.body, large.slice(0, large.indexOf('# End')), 'section reads have no new default cap');
	assert.equal((await f.read()).structuredContent.body, large, 'ordinary full-body defaults remain unchanged');
});

test('navigation rejects conflicting selectors and ambiguous or invalid sections without fallback', async () => {
	const f = fixture('# Same\nfirst\n# Same\nsecond');
	for (const [args, code] of [
		[{ outline: true, section: '1' }, 'note_navigation_conflict'],
		...[{ offset: 0 }, { max_chars: 0 }, { length: 1 }, { start_line: 1 }, { end_line: 1 }].map(selector => [{ outline: true, ...selector }, 'note_navigation_conflict']),
		...[{ start_line: 1 }, { end_line: 1 }].map(selector => [{ section: '1', ...selector }, 'note_navigation_conflict']),
		...[{ outline: true }, { outline: false }, { section: '1' }].flatMap(selector => ['metadata', 'file'].map(output => [{ ...selector, output }, 'note_file_slice_conflict'])),
		[{ section: 'Same' }, 'note_section_ambiguous'],
		[{ section: 'Sam' }, 'note_section_not_found'],
		[{ section: '9' }, 'note_section_not_found'],
	]) {
		const result = await f.read(args);
		assert.equal(result.isError, true, JSON.stringify(args));
		assert.equal(result.structuredContent.error.code, code, JSON.stringify(args));
		assert.ok(result.structuredContent.error.message, 'navigation errors carry a fixed safe explanation');
	}
	assert.equal((await f.read({ section: '2' })).structuredContent.body, '# Same\nsecond');
	assert.equal((await f.read({ section: '1' })).structuredContent.body, '# Same\nfirst\n');
});

test('empty outlines and HTML reads preserve their distinct behavior and file exports remain complete', async () => {
	const f = fixture('plain text 😀');
	assert.deepEqual((await f.read({ outline: true })).structuredContent.outline, []);
	assert.equal((await f.read({ section: '0' })).structuredContent.error.code, 'note_section_not_found');
	f.set({ body: '' });
	const empty = (await f.read({ outline: true })).structuredContent;
	assert.deepEqual(empty.outline, []);
	assertSource(empty, '');
	f.set({ markup_language: 2, body: '<h1>HTML</h1>\n<p>body 😀</p>' });
	for (const args of [{ outline: true }, { section: 'HTML' }]) {
		assert.equal((await f.read(args)).structuredContent.error.code, 'note_navigation_unsupported');
	}
	assert.equal((await f.read()).structuredContent.body, '<h1>HTML</h1>\n<p>body 😀</p>');
	const file = await f.read({ output: 'file' });
	assert.equal(file.isError, false);
	assert.equal(Object.hasOwn(file.structuredContent, 'body'), false);
	assert.equal(file.structuredContent.file.mime_type, 'text/html; charset=utf-8');
	assert.equal(Buffer.from(file.content[1].resource.blob, 'base64').toString('utf8'), '<h1>HTML</h1>\n<p>body 😀</p>');
	const metadata = await f.read({ output: 'metadata' });
	assert.equal(Object.hasOwn(metadata.structuredContent, 'body'), false);
	assert.equal(Object.hasOwn(metadata.structuredContent, 'file'), false);
});

test('keyword search reports the deepest actual source match without adding reads or semantic positions', async () => {
	const body = 'İ preamble\n# Parent\n' + 'padding\n'.repeat(30) + '## Child\n\tneedle 😀\n# End\nlast';
	const f = fixture(body);
	const keyword = (await f.tools.call('search_notes', { query: 'needle' })).structuredContent.results[0];
	assert.equal(keyword.section, '1.1');
	assert.equal(keyword.section_heading, 'Child');
	for (const query of ['notebook:Inbox', 'notebook:"With needle"', 'title:needle', 'body:needle', '-needle', '-title:"With needle"', 'missing']) {
		const row = (await f.tools.call('search_notes', { query })).structuredContent.results[0];
		assert.equal(Object.hasOwn(row, 'section'), false, query);
		assert.equal(Object.hasOwn(row, 'section_heading'), false, query);
	}
	const preamble = (await f.tools.call('search_notes', { query: 'preamble' })).structuredContent.results[0];
	assert.equal(preamble.section, '0');
	assert.equal(preamble.section_heading, '');
	const hybrid = (await f.tools.call('search_notes', { query: 'needle', mode: 'hybrid' })).structuredContent.results[0];
	assert.equal(hybrid.section, '1.1');
	assert.equal(hybrid.provenance, 'hybrid');
	const semantic = (await f.tools.call('search_notes', { query: 'needle', mode: 'semantic' })).structuredContent.results[0];
	assert.equal(Object.hasOwn(semantic, 'section'), false);
	f.set({ markup_language: 2 });
	assert.equal(Object.hasOwn((await f.tools.call('search_notes', { query: 'needle' })).structuredContent.results[0], 'section'), false);
	assert.equal(f.reads(), 0, 'search enrichment uses only already-returned source bodies');
});

test('catalog schemas separate outline metadata from paging and declare every navigation field', async () => {
	const f = fixture('# Heading\nbody');
	const tools = new Map(f.tools.list().map(tool => [tool.name, tool]));
	assert.equal(tools.has('read_notes'), false);
	for (const name of ['read_note', 'get_note']) {
		const schema = tools.get(name);
		assert.equal(schema.inputSchema.additionalProperties, false);
		assert.equal(schema.inputSchema.properties.outline.type, 'boolean');
		assert.equal(schema.inputSchema.properties.section.type, 'string');
		const success = schema.outputSchema.anyOf[0];
		const outlineBranch = success.anyOf.find(branch => branch.required.includes('outline'));
		const value = (await f.read({ outline: true }, name)).structuredContent;
		for (const key of [...success.required, ...outlineBranch.required]) assert.ok(Object.hasOwn(value, key), key);
		for (const key of pagingFields) assert.ok(outlineBranch.not.anyOf.some(branch => branch.required.includes(key)), key);
		assert.equal(success.properties.outline.items.additionalProperties, false);
		const section = (await f.read({ section: '1' }, name)).structuredContent;
		for (const key of ['section_path', 'section_heading', 'section_start_offset', 'section_end_offset']) {
			assert.ok(success.properties[key], key);
			assert.ok(Object.hasOwn(section, key), key);
		}
	}
	const searchRow = tools.get('search_notes').outputSchema.anyOf[0].properties.results.items;
	assert.equal(searchRow.additionalProperties, false);
	assert.equal(searchRow.properties.section.type, 'string');
	assert.equal(searchRow.properties.section_heading.type, 'string');
	assert.match(tools.get('read_note').description, /refresh the outline/);
});
