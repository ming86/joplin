import { bodyLines } from './body-lines.mjs';
import { identifier, requireValue, ServiceError } from './errors.mjs';

/** Recognize a plain input record supplied to the account service. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Keep the service's established decrypted, unlocked note boundary. */
const readable = note => note?.encryption_applied === 0 && !note.deleted_time && !note.is_locked;
/** Error codes that mean a listed note disappeared or became unreadable during this scan. */
const unavailableNoteCodes = new Set(['not_found', 'note_unavailable']);

/** Validate one selection array and return stable, deduplicated Joplin identifiers. */
function selectedIds(value) {
	requireValue(Array.isArray(value), 'invalid_grep_input');
	return [...new Set(value.map(id => {
		try { return identifier(id); }
		catch { throw new ServiceError('invalid_grep_input'); }
	}))];
}

/** Compile a single-line matcher without changing offsets in the source text. */
function compileMatcher(pattern, mode, caseSensitive) {
	const source = mode === 'literal' ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
	try { return new RegExp(source, caseSensitive ? 'u' : 'iu'); }
	catch { throw new ServiceError('invalid_grep_pattern'); }
}

/** Return true only for note records that meet the account's live-read policy. */
function scopeIncludes(note, selectedNoteIds, selectedNotebookIds, allReadable) {
	if (!readable(note)) return false;
	if (allReadable) return true;
	return selectedNoteIds.has(note.id) || selectedNotebookIds.has(note.parent_id);
}

/** Resolve explicit notebooks to the requested folders and, by default, their descendants. */
async function notebookScope(client, ids, includeDescendants, signal) {
	if (!ids.length) return new Set();
	const notebooks = await client.listAllNotebooks(signal);
	const byId = new Map(notebooks.map(notebook => [notebook.id, notebook]));
	for (const id of ids) {
		if (!byId.has(id)) throw new ServiceError('notebook_unavailable');
	}
	if (!includeDescendants) return new Set(ids);

	const roots = new Set(ids);
	const result = new Set();
	for (const notebook of notebooks) {
		let current = notebook;
		const visited = new Set();
		while (current && !visited.has(current.id)) {
			if (roots.has(current.id)) {
				result.add(notebook.id);
				break;
			}
			visited.add(current.id);
			current = current.parent_id ? byId.get(current.parent_id) : undefined;
		}
	}
	return result;
}

/** Keep a bounded line preview without cutting a UTF-16 surrogate pair in half. */
function preview(text, maxLineChars) {
	let end = maxLineChars === undefined ? text.length : Math.min(text.length, maxLineChars);
	if (end > 0 && end < text.length) {
		const previous = text.charCodeAt(end - 1);
		const next = text.charCodeAt(end);
		if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
	}
	const value = text.slice(0, end);
	return { text: value, truncated: value.length < text.length, line_length: text.length };
}

/** Build the public line shape from an exact source line. */
function lineResult(line, maxLineChars) {
	return { line_number: line.line_number, ...preview(line.text, maxLineChars) };
}

/** Find one match per source line and attach adjacent source lines from the same body. */
function hasMatchingLine(body, matcher) {
	const lines = bodyLines(body);
	return lines.some(line => matcher.test(line.text));
}

/** Create an account-bound literal or regular-expression line search service. */
export function createGrepService({ backend, permit, accountId }) {
	requireValue(typeof backend === 'function' && typeof permit === 'function'
		&& typeof accountId === 'string' && accountId.length > 0);
	const core = () => {
		const client = backend();
		requireValue(client && typeof client === 'object');
		return client;
	};

	return Object.freeze({
		/** Search readable note bodies and return one paginated row per matching source line. */
		async grepNotes(input, signal) {
			permit('read');
			requireValue(record(input), 'invalid_grep_input');
			const allowed = [
				'pattern', 'mode', 'case_sensitive', 'note_ids', 'notebook_ids', 'include_descendants',
				'context_before', 'context_after', 'max_line_chars', 'page', 'limit',
			];
			requireValue(Object.keys(input).every(key => allowed.includes(key)), 'invalid_grep_input');
			requireValue(typeof input.pattern === 'string' && input.pattern.length > 0, 'invalid_grep_input');
			const mode = input.mode ?? 'literal';
			requireValue(mode === 'literal' || mode === 'regex', 'invalid_grep_input');
			const caseSensitive = input.case_sensitive ?? true;
			requireValue(typeof caseSensitive === 'boolean', 'invalid_grep_input');
			const beforeCount = input.context_before ?? 0;
			const afterCount = input.context_after ?? 0;
			requireValue(Number.isSafeInteger(beforeCount) && beforeCount >= 0
				&& Number.isSafeInteger(afterCount) && afterCount >= 0, 'invalid_grep_input');
			const maxLineChars = input.max_line_chars;
			if (maxLineChars !== undefined) requireValue(Number.isSafeInteger(maxLineChars) && maxLineChars > 0, 'invalid_grep_input');
			const page = input.page ?? 1;
			const limit = input.limit ?? 20;
			requireValue(Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'invalid_pagination');
			const offset = (page - 1) * limit;
			requireValue(Number.isSafeInteger(offset), 'invalid_pagination');
			const pageEnd = offset + limit;
			requireValue(Number.isSafeInteger(pageEnd), 'invalid_pagination');

			const matcher = compileMatcher(input.pattern, mode, caseSensitive);
			const noteIdsSupplied = input.note_ids !== undefined;
			const notebookIdsSupplied = input.notebook_ids !== undefined;
			const selectedNoteIds = new Set(noteIdsSupplied ? selectedIds(input.note_ids) : []);
			const requestedNotebookIds = notebookIdsSupplied ? selectedIds(input.notebook_ids) : [];
			const includeDescendants = input.include_descendants ?? true;
			requireValue(typeof includeDescendants === 'boolean', 'invalid_grep_input');
			const client = core();
			const selectedNotebookIds = new Set(await notebookScope(client, requestedNotebookIds, includeDescendants, signal));
			const allReadable = !noteIdsSupplied && !notebookIdsSupplied;

			// A note-only request can validate its explicit IDs directly, without paging all metadata.
			const directNoteSelection = noteIdsSupplied && requestedNotebookIds.length === 0;
			let candidates;
			if (!allReadable && selectedNoteIds.size === 0 && selectedNotebookIds.size === 0) {
				candidates = [];
			} else if (directNoteSelection) {
				candidates = [...selectedNoteIds].sort().map(id => ({ id }));
			} else {
				const summaries = new Map();
				let summaryPage = 1;
				for (;;) {
					const result = await client.listNoteSummaries({ page: summaryPage, limit: 100 }, signal);
					for (const summary of result.items) summaries.set(summary.id, summary);
					if (!result.hasMore) break;
					summaryPage++;
				}
				for (const id of selectedNoteIds) {
					if (!readable(summaries.get(id))) throw new ServiceError('note_unavailable');
				}
				candidates = [...summaries.values()]
					.filter(summary => readable(summary) && scopeIncludes(summary, selectedNoteIds, selectedNotebookIds, allReadable))
					.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
			}
			const items = [];
			let matchIndex = 0;
			let hasMore = false;
			let finished = false;

			for (const candidate of candidates) {
				const id = candidate.id;
				let current;
				try { current = await client.getNote(id, signal); }
				catch (error) {
					if (unavailableNoteCodes.has(error?.code) && !selectedNoteIds.has(id)) continue;
					if (unavailableNoteCodes.has(error?.code)) throw new ServiceError('note_unavailable');
					throw error;
				}
				if (!readable(current)) {
					if (selectedNoteIds.has(id)) throw new ServiceError('note_unavailable');
					continue;
				}
				requireValue(current.id === id && typeof current.body === 'string', 'invalid_backend_response');
				if (!scopeIncludes(current, selectedNoteIds, selectedNotebookIds, allReadable)) continue;
				if (!hasMatchingLine(current.body, matcher)) continue;

				let snapshot;
				try { snapshot = await client.readNoteWithRevision(id, signal); }
				catch (error) {
					if (unavailableNoteCodes.has(error?.code) && !selectedNoteIds.has(id)) continue;
					if (unavailableNoteCodes.has(error?.code)) throw new ServiceError('note_unavailable');
					throw error;
				}
				if (!readable(snapshot)) {
					if (selectedNoteIds.has(id)) throw new ServiceError('note_unavailable');
					continue;
				}
				requireValue(snapshot.id === id && typeof snapshot.body === 'string'
					&& typeof snapshot.revision_id === 'string' && /^[a-f0-9]{32}$/.test(snapshot.revision_id), 'invalid_backend_response');
				if (!scopeIncludes(snapshot, selectedNoteIds, selectedNotebookIds, allReadable)) continue;

				const lines = bodyLines(snapshot.body);
				for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
					const line = lines[lineIndex];
					if (!matcher.test(line.text)) continue;
					if (matchIndex >= pageEnd) {
						hasMore = true;
						finished = true;
						break;
					}
					if (matchIndex >= offset) {
						items.push({
							note_id: id,
							title: snapshot.title ?? '',
							notebook_id: snapshot.parent_id || null,
							revision_id: snapshot.revision_id,
							...lineResult(line, maxLineChars),
							context_before: lines.slice(Math.max(0, lineIndex - beforeCount), lineIndex).map(value => lineResult(value, maxLineChars)),
							context_after: lines.slice(lineIndex + 1, Math.min(lines.length, lineIndex + afterCount + 1)).map(value => lineResult(value, maxLineChars)),
						});
					}
					matchIndex++;
				}
				if (finished) break;
			}

			return { accountId, items, page, limit, hasMore };
		},
	});
}
