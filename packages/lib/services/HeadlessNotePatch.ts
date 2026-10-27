import JoplinError from '../JoplinError';

/** A source line that a hunk keeps or removes. */
interface SourceOperation {
	/** The exact line text after removing the patch syntax prefix. */
	text: string;
	/** Whether the matched source line remains in the result. */
	keep: boolean;
}

/** One added line in a hunk. */
interface AdditionOperation {
	/** The exact inserted line text after removing the patch syntax prefix. */
	text: string;
}

/** An ordered source or addition operation inside a hunk. */
type PatchOperation =
	| { kind: 'source'; operation: SourceOperation }
	| { kind: 'addition'; operation: AdditionOperation };

/** A parsed hunk and its ordered source sequence. */
interface PatchHunk {
	/** Source and addition operations in patch order. */
	operations: PatchOperation[];
	/** Context and removal text used for exact matching against the original body. */
	sourceLines: string[];
}

/** A logical note line with its exact original following separator, if present. */
interface LineRecord {
	/** Text before this logical line's line ending. */
	text: string;
	/** Original LF, CRLF, lone CR, or empty when this record had no following break. */
	separator: string;
}

/** A line in the output, with a hunk-selected separator for newly needed boundaries. */
interface OutputLine extends LineRecord {
	/** Separator selected from the hunk window or original body when this line needs a new boundary. */
	fallbackSeparator?: string;
}

/** A uniquely located hunk in the original body. */
interface MatchedHunk {
	/** Parsed hunk operations. */
	hunk: PatchHunk;
	/** Inclusive starting index in the original logical-line array. */
	start: number;
	/** Exclusive ending index in the original logical-line array. */
	end: number;
	/** Separator selected once for boundaries introduced by this hunk. */
	fallbackSeparator: string;
}

/** Throw a fixed, content-free error for malformed patch syntax. */
function invalidPatch(): never {
	throw new JoplinError('The body patch is invalid.', 'note_patch_invalid');
}

/** Validate that a hunk contains source lines and at least one edit operation. */
function validateHunk(hunk: PatchHunk): void {
	if (!hunk.sourceLines.length || !hunk.operations.some(operation => operation.kind === 'addition' || !operation.operation.keep)) {
		invalidPatch();
	}
}

/** Parse LF, CRLF, or lone-CR syntax lines without treating one final separator as an operation. */
function parsePatch(patchText: string): PatchHunk[] {
	if (!patchText) invalidPatch();
	const lines = patchText.split(/\r\n|\r|\n/);
	if (/(?:\r\n|\r|\n)$/.test(patchText)) lines.pop();

	const hunks: PatchHunk[] = [];
	let current: PatchHunk | null = null;
	for (const line of lines) {
		if (line === '@@') {
			if (current) validateHunk(current);
			current = { operations: [], sourceLines: [] };
			hunks.push(current);
			continue;
		}

		if (!current || !line.length) invalidPatch();
		const prefix = line[0];
		const text = line.slice(1);
		if (prefix === ' ') {
			current.operations.push({ kind: 'source', operation: { text, keep: true } });
			current.sourceLines.push(text);
		} else if (prefix === '-') {
			current.operations.push({ kind: 'source', operation: { text, keep: false } });
			current.sourceLines.push(text);
		} else if (prefix === '+') {
			current.operations.push({ kind: 'addition', operation: { text } });
		} else {
			invalidPatch();
		}
	}

	if (current) validateHunk(current);
	if (!hunks.length) invalidPatch();
	return hunks;
}

/** Split note text into logical lines while retaining each exact source separator. */
function splitBody(body: string): LineRecord[] {
	const lines: LineRecord[] = [];
	let start = 0;
	for (let index = 0; index < body.length; index++) {
		const code = body.charCodeAt(index);
		if (code !== 10 && code !== 13) continue;

		const lineEnd = index;
		let separatorEnd = index + 1;
		if (code === 13 && body.charCodeAt(separatorEnd) === 10) separatorEnd++;
		lines.push({ text: body.slice(start, lineEnd), separator: body.slice(lineEnd, separatorEnd) });
		start = separatorEnd;
		index = separatorEnd - 1;
	}

	// This final record represents both an empty body and the empty line after a trailing separator.
	lines.push({ text: body.slice(start), separator: '' });
	return lines;
}

/** Find the first source line ending in a record range. */
function firstSeparator(records: LineRecord[]): string | undefined {
	return records.find(record => record.separator.length > 0)?.separator;
}

/** Locate exactly one complete source sequence in the original logical lines. */
function findUniqueMatch(hunk: PatchHunk, records: LineRecord[]): number {
	let matchStart = -1;
	const finalStart = records.length - hunk.sourceLines.length;
	for (let start = 0; start <= finalStart; start++) {
		let matches = true;
		for (let line = 0; line < hunk.sourceLines.length; line++) {
			if (records[start + line].text !== hunk.sourceLines[line]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		if (matchStart >= 0) {
			throw new JoplinError('The body patch matched the note body more than once.', 'note_patch_ambiguous');
		}
		matchStart = start;
	}

	if (matchStart < 0) throw new JoplinError('The body patch did not match the note body.', 'note_patch_not_found');
	return matchStart;
}

/** Select the separator used for boundaries that a changed hunk creates. */
function selectFallbackSeparator(window: LineRecord[], bodyRecords: LineRecord[]): string {
	return firstSeparator(window) || firstSeparator(bodyRecords) || '\n';
}

/** Apply one matched hunk while preserving source records for unchanged context. */
function applyHunk(match: MatchedHunk, records: LineRecord[]): OutputLine[] {
	const sourceRecords = records.slice(match.start, match.end);
	const output: OutputLine[] = [];
	let sourceIndex = 0;
	for (const { kind, operation } of match.hunk.operations) {
		if (kind === 'addition') {
			output.push({ text: operation.text, separator: '', fallbackSeparator: match.fallbackSeparator });
			continue;
		}

		const source = sourceRecords[sourceIndex++];
		if (operation.keep) output.push({ ...source, fallbackSeparator: match.fallbackSeparator });
	}

	// Identical replacements keep their exact source records and mixed line endings.
	if (output.length === sourceRecords.length && output.every((line, index) => line.text === sourceRecords[index].text)) {
		return sourceRecords;
	}
	return output;
}

/** Render logical lines using original separators first and selected hunk fallbacks at new boundaries. */
function renderBody(lines: OutputLine[]): string {
	let body = '';
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		body += line.text;
		if (index < lines.length - 1) body += line.separator || line.fallbackSeparator || '\n';
	}
	return body;
}

/** Apply exact, unique, source-ordered context hunks while preserving source separators; throw a note_patch_* JoplinError on rejection. */
export default function applyBodyPatch(originalBody: string, patchText: string): string {
	const hunks = parsePatch(patchText);
	const originalRecords = splitBody(originalBody);
	const matches: MatchedHunk[] = [];
	let previousEnd = 0;
	for (const hunk of hunks) {
		const start = findUniqueMatch(hunk, originalRecords);
		const end = start + hunk.sourceLines.length;
		if (matches.length && start < previousEnd) {
			throw new JoplinError('The body patch hunks are out of order or overlap.', 'note_patch_order');
		}
		const window = originalRecords.slice(start, end);
		matches.push({ hunk, start, end, fallbackSeparator: selectFallbackSeparator(window, originalRecords) });
		previousEnd = end;
	}

	const output: OutputLine[] = [];
	let sourceCursor = 0;
	for (const match of matches) {
		for (const line of originalRecords.slice(sourceCursor, match.start)) output.push(line);
		for (const line of applyHunk(match, originalRecords)) output.push(line);
		sourceCursor = match.end;
	}
	for (const line of originalRecords.slice(sourceCursor)) output.push(line);
	return renderBody(output);
}
