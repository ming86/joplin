import { createHash } from 'node:crypto';
import { ServiceError } from '../errors.mjs';
import { embeddedResourcesResult } from './attachment-tools.mjs';
import { bodyTotalLineCount } from './body-line-count.mjs';

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
		body_total_line_count: bodyTotalLineCount(text),
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

/** Measure one complete captured body using the note read tools' length conventions. */
function bodyMetadata(text) {
	return {
		body_length: text.length,
		body_size_bytes: Buffer.byteLength(text, 'utf8'),
		body_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
		body_total_line_count: bodyTotalLineCount(text),
	};
}

/** Return an available side without its body, plus metadata or an immutable file export. */
function completeSide(side, output, exported) {
	if (side.status !== 'available' || !side.note) return { value: { id: side.id, status: side.status } };
	const { body, ...note } = side.note;
	if (output === 'metadata') {
		return { value: { id: side.id, status: side.status, note: { ...note, ...bodyMetadata(body) } } };
	}

	const { file, resource } = exported;
	return { value: { id: side.id, status: side.status, note: { ...note, body_total_line_count: bodyTotalLineCount(body), file } }, resource };
}

/** Register the two read-only MCP tools for device-local sync conflicts. */
export function registerConflictTools(add, service, { getFileResources } = {}) {
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
		'Read the current conflict copy and original note for one device-local sync conflict. Each side keeps its availability status; note content is returned only when that side is available. body_total_line_count describes each complete available body in every output mode, independent of body chunks and visual wrapping: CRLF, LF and lone CR each count as one break, a trailing break adds a final empty line, and an empty body has one line. Use output=metadata when the body size is unknown, or output=file to read a large body without inline content. This response does not provide an edit revision: call read_note for the note you plan to edit, then pass its current revision_id as base_revision_id to update_note.',
		object({
			id: { ...id, description: 'The conflict note id returned by list_conflicts.' },
			output: { type: 'string', enum: ['inline', 'file', 'metadata'], default: 'inline', description: 'Return complete bodies inline, as UTF-8 files, or metadata only. Use metadata when size is unknown and file for large bodies. File and metadata output cannot be combined with offset or max_chars.' },
			offset: { type: 'integer', description: 'UTF-16 code-unit offset applied independently to each available note body. Defaults to 0; returned offsets avoid splitting a surrogate pair.', minimum: 0 },
			max_chars: { type: 'integer', description: 'Maximum UTF-16 code units returned from each available note body. Omitted or 0 returns the full body from offset; a boundary may include one extra code unit to keep a surrogate pair intact.', minimum: 0 },
		}, ['id']),
		async (args, signal, context = {}) => {
			const output = args.output ?? 'inline';
			if (output !== 'inline' && ['offset', 'max_chars'].some(key => Object.hasOwn(args, key))) {
				throw new ServiceError('note_file_slice_conflict');
			}

			const result = await service.readConflict({ id: args.id }, signal);
			if (output === 'inline') {
				return {
					...result,
					conflict: chunkSide(result.conflict, args.offset, args.max_chars),
					original: chunkSide(result.original, args.offset, args.max_chars),
				};
			}

			const available = [['conflict', result.conflict], ['original', result.original]]
				.filter(([, side]) => side.status === 'available' && side.note);
			// Publish both sides together so saturation cannot retain an export whose URI was never returned.
			const exported = output === 'file' && available.length ? getFileResources().exportTexts(available.map(([name, side]) => ({
				text: side.note.body,
				filename: `${name}-${side.note.id}.${side.note.markup_language === 2 ? 'html' : 'md'}`,
				mimeType: side.note.markup_language === 2 ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
			})), context.responsePayload) : [];
			const bySide = new Map(available.map(([name], index) => [name, exported[index]]));
			const conflict = completeSide(result.conflict, output, bySide.get('conflict'));
			const original = completeSide(result.original, output, bySide.get('original'));
			const metadata = { ...result, conflict: conflict.value, original: original.value };
			if (output === 'metadata') return metadata;

			return embeddedResourcesResult(metadata, [conflict.resource, original.resource].filter(Boolean));
		},
		readAnnotations,
	);
}
