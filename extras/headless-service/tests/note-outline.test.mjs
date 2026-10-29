import test from 'node:test';
import assert from 'node:assert/strict';
import { noteOutline, normalizeHeading, resolveNoteSection } from '../src/note-outline.mjs';
import { ServiceError } from '../src/errors.mjs';

test('noteOutline assigns nearest-shallower paths and whole-section bounds', () => {
	const body = 'Preamble\n# Root\nintro\n### Deep\ndeep text\n## Child\nchild text\n# Next';
	const outline = noteOutline(body);

	assert.deepEqual(outline.map(({ path, heading, level }) => ({ path, heading, level })), [
		{ path: '0', heading: '', level: 0 },
		{ path: '1', heading: 'Root', level: 1 },
		{ path: '1.1', heading: 'Deep', level: 3 },
		{ path: '1.2', heading: 'Child', level: 2 },
		{ path: '2', heading: 'Next', level: 1 },
	]);
	assert.equal(outline[0].start_offset, 0);
	assert.equal(outline[0].end_offset, body.indexOf('# Root'));
	assert.equal(outline[0].end_line, 1);
	assert.equal(outline[1].end_offset, body.indexOf('# Next'));
	assert.equal(outline[1].end_line, 7);
	assert.equal(outline[2].end_offset, body.indexOf('## Child'));
	assert.equal(outline[2].end_line, 5);
	assert.equal(outline[3].end_offset, body.indexOf('# Next'));
	assert.equal(outline[3].end_line, 7);
	assert.equal(outline[4].end_offset, body.length);
	assert.equal(outline[4].end_line, 8);
});

test('noteOutline omits empty preambles and notes without Markdown headings', () => {
	assert.deepEqual(noteOutline(''), []);
	assert.deepEqual(noteOutline('plain text\nwith no headings'), []);
	assert.deepEqual(noteOutline('# Heading'), [{
		path: '1',
		heading: 'Heading',
		level: 1,
		start_offset: 0,
		end_offset: 9,
		start_line: 1,
		end_line: 1,
	}]);
	assert.deepEqual(noteOutline('\n# Heading')[0], {
		path: '0',
		heading: '',
		level: 0,
		start_offset: 0,
		end_offset: 1,
		start_line: 1,
		end_line: 1,
	});
});

test('noteOutline preserves original UTF-16 offsets and line numbers across newline styles', () => {
	const body = '😀 lead\r\n# Alpha\rline\r## Beta\nβ\n# Omega 😀\n';
	const outline = noteOutline(body);

	assert.deepEqual(outline.map(({ path, heading, start_line, end_line }) => ({ path, heading, start_line, end_line })), [
		{ path: '0', heading: '', start_line: 1, end_line: 1 },
		{ path: '1', heading: 'Alpha', start_line: 2, end_line: 5 },
		{ path: '1.1', heading: 'Beta', start_line: 4, end_line: 5 },
		{ path: '2', heading: 'Omega 😀', start_line: 6, end_line: 6 },
	]);
	assert.equal(outline[0].end_offset, body.indexOf('# Alpha'));
	assert.equal(outline[1].start_offset, body.indexOf('# Alpha'));
	assert.equal(outline[1].end_offset, body.indexOf('# Omega'));
	assert.equal(outline[2].start_offset, body.indexOf('## Beta'));
	assert.equal(outline[3].end_offset, body.length);
});

test('noteOutline uses Markdown tokens for fenced and setext heading syntax', () => {
	const body = '# Top\n\n```md\n## Fake\n```\n\nSub heading\n----------\ntext';
	const outline = noteOutline(body);

	assert.deepEqual(outline.map(({ path, heading, level }) => ({ path, heading, level })), [
		{ path: '1', heading: 'Top', level: 1 },
		{ path: '1.1', heading: 'Sub heading', level: 2 },
	]);
	assert.equal(outline[1].start_offset, body.indexOf('Sub heading'));
	assert.equal(outline[0].end_offset, body.length);
});

test('resolveNoteSection normalizes whitespace and resolves exact case-insensitive headings', () => {
	const sections = noteOutline('Intro\n# Main   Heading\n## Child');
	assert.equal(normalizeHeading('  a\t b\n'), 'a b');
	assert.equal(resolveNoteSection(sections, '  main\t heading ').path, '1');
	assert.equal(resolveNoteSection(sections, '1.1').heading, 'Child');
	assert.equal(resolveNoteSection(sections, '0').path, '0');
});

test('resolveNoteSection gives positional paths precedence over matching heading text', () => {
	const pathMatch = { path: '1', heading: 'First', level: 1 };
	const headingMatch = { path: '2', heading: '1', level: 1 };
	assert.equal(resolveNoteSection([pathMatch, headingMatch], '1'), pathMatch);
});

test('resolveNoteSection reports duplicate and unknown headings with safe service errors', () => {
	const sections = noteOutline('# Repeated   secret\n# Repeated secret');
	assert.throws(() => resolveNoteSection(sections, 'repeated SECRET'), error => {
		assert.ok(error instanceof ServiceError);
		assert.equal(error.code, 'note_section_ambiguous');
		assert.equal(error.message, 'note_section_ambiguous');
		return true;
	});
	assert.throws(() => resolveNoteSection(sections, '999'), error => error.code === 'note_section_not_found');
	assert.throws(() => resolveNoteSection(sections, 'Repeated'), error => error.code === 'note_section_not_found');
});
