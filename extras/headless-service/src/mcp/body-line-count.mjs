/** Count logical body lines: CRLF, LF and CR each break a line; empty text has one. */
export function bodyTotalLineCount(text) {
	let count = 1;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 13) {
			count++;
			if (text.charCodeAt(index + 1) === 10) index++;
		} else if (code === 10) {
			count++;
		}
	}
	return count;
}
