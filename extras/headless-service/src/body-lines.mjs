/**
 * Split text into logical lines while retaining the exact source offsets.
 * CRLF is one separator; LF and lone CR are separators as well. A trailing
 * separator creates a final empty line, and empty text contains one empty line.
 *
 * @param {string} text Complete source text.
 * @returns {Array<{line_number: number, start: number, end: number, separator_end: number, text: string}>}
 * One-based line numbers and UTF-16 code-unit offsets. `end` excludes the
 * separator, while `separator_end` includes it when present.
 */
export function bodyLines(text) {
	const lines = [];
	let start = 0;
	let lineNumber = 1;

	// Keep each original separator attached to its source range without placing
	// it in the line's text, so callers can select either line text or exact bytes.
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code !== 10 && code !== 13) continue;

		const end = index;
		let separatorEnd = index + 1;
		if (code === 13 && text.charCodeAt(separatorEnd) === 10) separatorEnd++;
		lines.push({
			line_number: lineNumber++,
			start,
			end,
			separator_end: separatorEnd,
			text: text.slice(start, end),
		});
		start = separatorEnd;
		index = separatorEnd - 1;
	}

	// This also represents the empty body and the final empty line after a break.
	lines.push({
		line_number: lineNumber,
		start,
		end: text.length,
		separator_end: text.length,
		text: text.slice(start),
	});
	return lines;
}
