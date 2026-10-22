/** MCP schema for native 32-character Joplin IDs. */
const id = { type: 'string', pattern: '^[a-f0-9]{32}$' };
/** MCP schema for the existing page-number range. */
const page = { type: 'integer', minimum: 1, maximum: 1000000 };
/** MCP schema for a page size supported by the headless API. */
const limit = { type: 'integer', minimum: 1, maximum: 100, default: 20 };
/** Build closed tool inputs so callers cannot add unrecognized selectors. */
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
/** MCP annotations for read-only conflict inspection. */
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Return one UTF-16-safe body slice and its continuation metadata. */
function bodyChunk(text, requestedOffset, requestedLength) {
	let offset = Math.min(requestedOffset ?? 0, text.length);
	if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')) offset--;
	let end = requestedLength === undefined || requestedLength === 0
		? text.length
		: Math.min(offset + requestedLength, text.length);
	if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end++;
	const body = text.slice(offset, end);
	const hasMore = end < text.length;
	return {
		body,
		body_length: text.length,
		body_offset: offset,
		body_returned_chars: body.length,
		has_more: hasMore,
		offset,
		nextOffset: hasMore ? end : null,
		totalLength: text.length,
		offsetUnit: 'utf16-code-unit',
	};
}

/** Keep an unavailable side's status and relation while returning no content. */
function chunkSide(side, offset, maxChars) {
	if (side.status !== 'available' || !side.note) return { id: side.id, status: side.status };
	return {
		id: side.id,
		status: side.status,
		note: { ...side.note, ...bodyChunk(side.note.body, offset, maxChars) },
	};
}

/** Register the two read-only MCP tools for device-local sync conflicts. */
export function registerConflictTools(add, service) {
	add('list_conflicts',
		'List this device\'s local sync conflicts. Use read_conflict to inspect the conflict copy and original note as they currently exist on this device.',
		object({
			page: { ...page, description: 'Page number. Defaults to 1.' },
			limit: { ...limit, description: 'Maximum conflicts to return per page. Defaults to 20.' },
		}),
		(args, signal) => service.listConflicts({ page: args.page, limit: args.limit ?? 20 }, signal),
		readAnnotations,
	);

	add('read_conflict',
		'Read the current conflict copy and original note content for one device-local sync conflict. Each side keeps its availability status; current note content is returned only when that side is available. Use offset and max_chars for UTF-16-safe body chunks. To edit either note, first call read_note for that note, then pass its revision_id as base_revision_id to update_note.',
		object({
			id: { ...id, description: 'The conflict note id returned by list_conflicts.' },
			offset: { type: 'integer', description: 'UTF-16 code-unit offset applied independently to each available note body. Defaults to 0; returned offsets avoid splitting a surrogate pair.', minimum: 0 },
			max_chars: { type: 'integer', description: 'Maximum UTF-16 code units returned from each available note body. Omitted or 0 returns the full body from offset; a boundary may include one extra code unit to keep a surrogate pair intact.', minimum: 0 },
		}, ['id']),
		async (args, signal) => {
			const result = await service.readConflict({ id: args.id }, signal);
			return {
				...result,
				conflict: chunkSide(result.conflict, args.offset, args.max_chars),
				original: chunkSide(result.original, args.offset, args.max_chars),
			};
		},
		readAnnotations,
	);
}
