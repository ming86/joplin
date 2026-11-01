import { parentPort, workerData } from 'node:worker_threads';

/** Preserve JavaScript Unicode matching with the caller's already validated pattern. */
const matcher = new RegExp(workerData.pattern, workerData.caseSensitive ? 'u' : 'iu');

/**
 * Scan one body without retaining every source line or matching index.
 * `any` stops at the first match; `page` skips earlier matches and retains only
 * the requested page plus its lookahead. Indices follow bodyLines' CR/LF rules.
 */
function matchBody({ body, kind, skip = 0, take = 1 }) {
	const indices = [];
	let matchCount = 0;
	let start = 0;
	let lineIndex = 0;
	for (let end = 0; end <= body.length; end++) {
		const code = body.charCodeAt(end);
		if (end !== body.length && code !== 10 && code !== 13) continue;
		if (matcher.test(body.slice(start, end))) {
			matchCount++;
			if (kind === 'any') return { matched: true };
			if (matchCount > skip) indices.push(lineIndex);
			if (indices.length === take) return { indices, matchCount };
		}
		if (code === 13 && body.charCodeAt(end + 1) === 10) end++;
		start = end + 1;
		lineIndex++;
	}
	return kind === 'any' ? { matched: false } : { indices, matchCount };
}

// Jobs are serial within one grep call; no body survives beyond this callback.
parentPort.on('message', job => parentPort.postMessage(matchBody(job)));
