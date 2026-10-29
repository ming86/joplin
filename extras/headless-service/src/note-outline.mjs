import { createRequire } from 'node:module';
import { bodyLines } from './body-lines.mjs';
import { ServiceError } from './errors.mjs';

const rendererRequire = createRequire(new URL('../../../packages/renderer/package.json', import.meta.url));
let MarkdownIt;

/** @typedef {object} RawHeading
 * @property {number} level Markdown heading level from its `heading_open` token.
 * @property {string} heading Normalized MarkdownIt inline content.
 * @property {number} lineIndex Zero-based logical line index from the token map.
 * @property {number} start Whole-source UTF-16 offset at that line's start.
 */

/** @typedef {object} NoteOutlineEntry
 * @property {string} path Positional heading path, with `0` reserved for a preamble.
 * @property {string} heading Normalized full Markdown heading text, or empty for the preamble.
 * @property {number} level Markdown heading level, or zero for the preamble.
 * @property {number} start_offset Inclusive whole-source UTF-16 offset.
 * @property {number} end_offset Exclusive whole-source UTF-16 offset.
 * @property {number} start_line Inclusive whole-source line number, starting at one.
 * @property {number} end_line Inclusive whole-source line number, starting at one.
 */

/** Load the renderer workspace's pinned Markdown parser on first use.
 * @returns {typeof import('markdown-it')}
 */
function markdownIt() {
	if (MarkdownIt) return MarkdownIt;
	try {
		MarkdownIt = rendererRequire('markdown-it');
	} catch (cause) {
		throw new ServiceError('markdown_dependency_unavailable', false, 'markdown_dependency_unavailable', { cause });
	}
	return MarkdownIt;
}

/** Collapse heading whitespace so outline values can be copied into selectors.
 * @param {string} heading MarkdownIt inline heading content.
 * @returns {string} Whitespace-collapsed heading content.
 */
export function normalizeHeading(heading) {
	return heading.replace(/\s+/g, ' ').trim();
}

/** Parse Markdown heading tokens and map their logical lines to original source offsets.
 * MarkdownIt normalizes line endings, so bodyLines supplies the matching original
 * source offset for each token-map line.
 * @param {string} body Complete source Markdown.
 * @param {ReturnType<typeof bodyLines>} lines Original source line map.
 * @returns {RawHeading[]} Heading tokens in source order.
 */
function parseHeadings(body, lines) {
	const MarkdownParser = markdownIt();
	const tokens = new MarkdownParser().parse(body, {});
	const headings = [];

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.type !== 'heading_open' || !token.map) continue;

		const inline = tokens[index + 1];
		headings.push({
			level: Number(token.tag.slice(1)),
			heading: inline?.type === 'inline' ? normalizeHeading(inline.content) : '',
			lineIndex: token.map[0],
			start: lines[token.map[0]]?.start ?? body.length,
		});
	}
	return headings;
}

/** Assign unique positional paths using the nearest preceding shallower heading.
 * @param {RawHeading[]} headings Headings in source order.
 * @returns {string[]} Positional paths aligned with `headings`.
 */
function buildPaths(headings) {
	const stack = [];
	const siblingCounts = new Map();
	const paths = [];

	for (const heading of headings) {
		while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
		const parentPath = stack.map(item => item.counter).join('.');
		const counter = (siblingCounts.get(parentPath) ?? 0) + 1;
		siblingCounts.set(parentPath, counter);
		stack.push({ level: heading.level, counter });
		paths.push(stack.map(item => item.counter).join('.'));
	}
	return paths;
}

/** Find each heading's end at the next heading of equal or higher level.
 * @param {RawHeading[]} headings Headings in source order.
 * @param {number} bodyLength Source length in UTF-16 code units.
 * @returns {number[]} Exclusive end offsets aligned with `headings`.
 */
function sectionEnds(headings, bodyLength) {
	const ends = Array(headings.length).fill(bodyLength);
	const openSections = [];

	for (let index = 0; index < headings.length; index++) {
		const heading = headings[index];
		while (openSections.length && headings[openSections[openSections.length - 1]].level >= heading.level) {
			ends[openSections.pop()] = heading.start;
		}
		openSections.push(index);
	}
	return ends;
}

/** Convert an exclusive source offset into the last inclusive source line.
 * @param {ReturnType<typeof bodyLines>} lines Original source line map.
 * @param {number} offset Exclusive whole-source UTF-16 offset.
 * @returns {number} One-based inclusive line containing the final selected source character.
 */
function endLineForOffset(lines, offset) {
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (lines[middle].start < offset) low = middle + 1;
		else high = middle;
	}
	if (lines[low]?.start === offset) return Math.max(1, low);
	return lines[low - 1]?.line_number ?? 1;
}

/** Build the complete Markdown outline with whole-source UTF-16 offsets.
 * @param {string} body Complete source Markdown.
 * @returns {NoteOutlineEntry[]} Outline entries; empty when the note has no headings.
 */
export function noteOutline(body) {
	const lines = bodyLines(body);
	const headings = parseHeadings(body, lines);
	if (headings.length === 0) return [];

	const paths = buildPaths(headings);
	const ends = sectionEnds(headings, body.length);
	const sections = [];
	const preambleEnd = headings[0].start;
	if (preambleEnd > 0) {
		sections.push({
			path: '0',
			heading: '',
			level: 0,
			start_offset: 0,
			end_offset: preambleEnd,
			start_line: 1,
			end_line: endLineForOffset(lines, preambleEnd),
		});
	}

	for (let index = 0; index < headings.length; index++) {
		const heading = headings[index];
		const end = ends[index];
		sections.push({
			path: paths[index],
			heading: heading.heading,
			level: heading.level,
			start_offset: heading.start,
			end_offset: end,
			start_line: heading.lineIndex + 1,
			end_line: endLineForOffset(lines, end),
		});
	}
	return sections;
}

/** Resolve a positional path or an exact, case-insensitive full heading.
 * @param {NoteOutlineEntry[]} sections Entries returned by `noteOutline`.
 * @param {string} address Positional path or normalized full heading.
 * @returns {NoteOutlineEntry} The unique matching section.
 * @throws {ServiceError} `note_section_not_found` or `note_section_ambiguous`.
 */
export function resolveNoteSection(sections, address) {
	const normalizedAddress = normalizeHeading(address);
	const byPath = sections.find(section => section.path === normalizedAddress);
	if (byPath) return byPath;

	if (/^[0-9]+(?:\.[0-9]+)*$/.test(normalizedAddress)) {
		throw new ServiceError('note_section_not_found');
	}

	const matchingSections = sections.filter(section => section.path !== '0' && section.heading.toLowerCase() === normalizedAddress.toLowerCase());
	if (matchingSections.length === 1) return matchingSections[0];
	if (matchingSections.length > 1) throw new ServiceError('note_section_ambiguous');
	throw new ServiceError('note_section_not_found');
}
