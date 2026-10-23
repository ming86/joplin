/** Build a closed object schema for the fixed result records. */
const object = (properties, required = Object.keys(properties), description) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
	...(description ? { description } : {}),
});

/** JSON-safe values retained in revision metadata. */
const jsonValueSchema = { type: ['string', 'number', 'boolean', 'null', 'array', 'object'] };

/** Record one side of a metadata change while preserving field presence. */
const metadataValue = {
	oneOf: [
		object({ present: { const: false, description: 'The metadata field was absent.' } }),
		object({
			present: { const: true, description: 'The metadata field existed.' },
			value: { ...jsonValueSchema, description: 'The JSON value stored for this field.' },
		}),
	],
};

/** UTF-16-safe body chunk fields added by the revision and conflict readers. */
const bodyChunkProperties = {
	body_total_line_count: { type: 'integer', minimum: 1, description: 'Logical line count of the complete body, independent of this chunk. CRLF, LF and lone CR each count as one break; a trailing break adds a final empty line, and an empty body has one line.' },
	body_length: { type: 'integer', description: 'Total body length in UTF-16 code units.' },
	body_offset: { type: 'integer', description: 'Actual body start offset in UTF-16 code units, adjusted to avoid splitting a surrogate pair.' },
	body_returned_chars: { type: 'integer', description: 'Number of body UTF-16 code units returned.' },
	has_more: { type: 'boolean', description: 'Whether more body content follows this chunk.' },
	offset: { type: 'integer', description: 'Actual body start offset in UTF-16 code units; matches body_offset.' },
	nextOffset: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Next UTF-16 code-unit offset, or null when the full body has been returned.' },
	totalLength: { type: 'integer', description: 'Total body length in UTF-16 code units; matches body_length.' },
	offsetUnit: { const: 'utf16-code-unit', description: 'Unit used by the body offsets and lengths.' },
};

/** File metadata returned when a complete text body is stored as an MCP resource. */
const fileDescriptor = object({
	uri: { type: 'string', description: 'Opaque resource URI used to read the exported file.' },
	filename: { type: 'string', description: 'Suggested download filename.' },
	mime_type: { type: 'string', description: 'MIME type of the UTF-8 file.' },
	size: { type: 'integer', minimum: 0, description: 'File size in UTF-8 bytes.' },
	sha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA-256 of the exact UTF-8 file bytes.' },
	expires_at: { type: 'string', format: 'date-time', description: 'Date and time after which the resource URI expires.' },
});

/** Full-body measurements returned when body text is omitted. */
const bodyMeasureProperties = {
	body_length: { type: 'integer', minimum: 0, description: 'Full body length in UTF-16 code units.' },
	body_size_bytes: { type: 'integer', minimum: 0, description: 'Full body size in UTF-8 bytes.' },
	body_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA-256 of the full body encoded as UTF-8.' },
	body_total_line_count: { type: 'integer', minimum: 1, description: 'Logical line count of the complete body; CRLF, LF and lone CR each count as one break, a trailing break adds a final empty line, and an empty body has one line.' },
};

/**
 * Keep a union of fields visible to clients that inspect object properties, while
 * requiring one exact closed shape to match the selected output mode.
 */
function outputModeSchema(variants, description) {
	const properties = Object.assign({}, ...variants.map(variant => variant.properties));
	const sharedRequired = variants.map(variant => variant.required)
		.reduce((shared, required) => shared.filter(field => required.includes(field)));
	return {
		type: 'object',
		properties,
		required: sharedRequired,
		additionalProperties: false,
		description,
		oneOf: variants,
	};
}

/** Summary row in a note revision page. */
const revisionSummary = object({
	revision_id: { type: 'string', description: 'Native Joplin revision identifier.' },
	captured_time: { type: 'number', description: 'Revision capture time in Unix epoch milliseconds.' },
	parent_revision_id: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Parent revision identifier, or null for the first revision.' },
	accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
});

/** One tracked metadata field changed between two revision snapshots. */
const metadataChange = object({
	field: { type: 'string', description: 'Name of the tracked metadata field.' },
	from: { ...metadataValue, description: 'Value before the change, including whether the field existed.' },
	to: { ...metadataValue, description: 'Value after the change, including whether the field exists.' },
});

/** Current native note fields retained for every available conflict output mode. */
const conflictNoteContext = {
	id: { type: 'string', description: 'Native note identifier.' },
	parent_id: { type: 'string', description: 'Parent notebook identifier; an empty string denotes the root.' },
	title: { type: 'string', description: 'Current note title.' },
	created_time: { type: 'number', description: 'Note creation time in Joplin millisecond timestamp format.' },
	updated_time: { type: 'number', description: 'Note update time in Joplin millisecond timestamp format.' },
	is_todo: { type: 'number', description: 'Native to-do flag, encoded numerically as 0 or 1.' },
	todo_completed: { type: 'number', description: 'To-do completion time in milliseconds, or 0 while open.' },
	markup_language: { type: 'number', description: 'Native markup language identifier.' },
	is_conflict: { type: 'number', description: 'Native conflict flag, encoded numerically as 0 or 1.' },
	conflict_original_id: { type: 'string', description: 'Original note identifier, or an empty string when unlinked.' },
};

/** Exact note shape for one available conflict side output mode. */
const conflictNote = outputModeSchema([
	object({
		...conflictNoteContext,
		body: { type: 'string', description: 'Current note body in its native markup format; may be a chunk.' },
		...bodyChunkProperties,
	}, Object.keys({ ...conflictNoteContext, body: true, ...bodyChunkProperties }), 'Available conflict note with a UTF-16-safe inline body chunk.'),
	object({
		...conflictNoteContext,
		body_total_line_count: { type: 'integer', minimum: 1, description: 'Logical line count of the complete current body, independent of body chunks or visual wrapping.' },
		file: { ...fileDescriptor, description: 'Complete current note body exported as a UTF-8 file.' },
	}, [...Object.keys(conflictNoteContext), 'body_total_line_count', 'file'], 'Available conflict note with its body exported as a UTF-8 file.'),
	object({
		...conflictNoteContext,
		...bodyMeasureProperties,
	}, [...Object.keys(conflictNoteContext), ...Object.keys(bodyMeasureProperties)], 'Available conflict note with body measurements and no body text.'),
], 'Native fields for an available conflict side and the selected body output mode.');

/** Create the status-specific result schema for one conflict side. */
function conflictSide(statuses, idSchema) {
	return {
		oneOf: [
			object({
				id: idSchema,
				status: { const: 'available', description: 'The side is readable on this device.' },
				note: { ...conflictNote, description: 'Current native note fields and the selected body output mode.' },
			}, ['id', 'status', 'note'], 'Available side with readable current note fields.'),
			...statuses.map(status => object({
				id: idSchema,
				status: { const: status, description: 'Why the side has no readable note content.' },
			}, ['id', 'status'], `Unavailable side: ${status}.`)),
		],
	};
}

const stringId = { type: 'string', description: 'Native note identifier.' };
const conflictSideSchema = conflictSide(['trashed', 'encrypted', 'locked'], stringId);
const originalSideSchema = conflictSide(['missing', 'trashed', 'encrypted', 'locked'], stringId);
originalSideSchema.oneOf.push(object({
	id: { type: 'null', description: 'No original note is linked to this conflict.' },
	status: { const: 'unlinked', description: 'The conflict has no linked original note.' },
}, ['id', 'status'], 'No original note is linked to this conflict.'));

const revisionContext = {
	note_id: { type: 'string', description: 'Original note identifier, including when the live note has been deleted.' },
	revision_id: { type: 'string', description: 'Native Joplin revision identifier.' },
	captured_time: { type: 'number', description: 'Revision capture time in Unix epoch milliseconds.' },
	title: { type: 'string', description: 'Historical note title.' },
	metadata: {
		type: 'object',
		additionalProperties: jsonValueSchema,
		description: 'JSON-safe tracked metadata from the historical note.',
	},
	accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
};

/** Success output JSON Schemas for the native revision and conflict MCP tools. */
export const revisionConflictOutputSchemas = {
	list_note_revisions: object({
		accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
		items: { type: 'array', items: revisionSummary, description: 'Revision rows on this page, newest first.' },
		hasMore: { type: 'boolean', description: 'Whether another visible revision exists after this page.' },
	}),
	read_note_revision: outputModeSchema([
		object({
			...revisionContext,
			body: { type: 'string', description: 'Historical note body in its original markup format; may be a chunk.' },
			...bodyChunkProperties,
		}, [...Object.keys(revisionContext), 'body', ...Object.keys(bodyChunkProperties)], 'Historical note revision with its body inline.'),
		object({
			...revisionContext,
			body_total_line_count: { type: 'integer', minimum: 1, description: 'Logical line count of the complete historical body, independent of body chunks or visual wrapping.' },
			file: { ...fileDescriptor, description: 'Complete historical note body exported as a UTF-8 file.' },
		}, [...Object.keys(revisionContext), 'body_total_line_count', 'file'], 'Historical note revision with its body exported as a UTF-8 file.'),
		object({
			...revisionContext,
			...bodyMeasureProperties,
		}, [...Object.keys(revisionContext), ...Object.keys(bodyMeasureProperties)], 'Historical note revision with body measurements and no body text.'),
	], 'Historical note context and exactly one body output mode.'),
	compare_note_revisions: outputModeSchema([
		object({
			accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
			note_id: { type: 'string', description: 'Original note identifier.' },
			from_revision_id: { type: 'string', description: 'Native revision identifier used as the comparison base.' },
			to_revision_id: { type: 'string', description: 'Native destination revision identifier, also returned when the current live state was captured.' },
			to_current: { type: 'boolean', description: 'True when the destination was captured from the current live note during this request.' },
			from_body_total_line_count: { type: 'integer', minimum: 1, description: 'Logical line count of the complete source revision body; CRLF, LF and lone CR each count as one break, and trailing breaks include the final empty line.' },
			to_body_total_line_count: { type: 'integer', minimum: 1, description: 'Logical line count of the complete destination revision body; CRLF, LF and lone CR each count as one break, and trailing breaks include the final empty line.' },
			title_diff: { type: 'string', description: 'Unified title patch, or an empty string when unchanged.' },
			body_diff: { type: 'string', description: 'Unified body patch, or an empty string when unchanged.' },
			metadata_changes: { type: 'array', items: metadataChange, description: 'Tracked metadata changes, sorted by field name.' },
		}, undefined, 'Revision comparison with both text diffs inline.'),
		object({
			accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
			note_id: { type: 'string', description: 'Original note identifier.' },
			from_revision_id: { type: 'string', description: 'Native revision identifier used as the comparison base.' },
			to_revision_id: { type: 'string', description: 'Native destination revision identifier, also returned when the current live state was captured.' },
			to_current: { type: 'boolean', description: 'True when the destination was captured from the current live note during this request.' },
			from_body_total_line_count: { type: 'integer', minimum: 1, description: 'Logical line count of the complete source revision body; CRLF, LF and lone CR each count as one break, and trailing breaks include the final empty line.' },
			to_body_total_line_count: { type: 'integer', minimum: 1, description: 'Logical line count of the complete destination revision body; CRLF, LF and lone CR each count as one break, and trailing breaks include the final empty line.' },
			metadata_changes: { type: 'array', items: metadataChange, description: 'Tracked metadata changes, sorted by field name.' },
			file: { ...fileDescriptor, description: 'Both text diffs exported together as a UTF-8 file.' },
		}, undefined, 'Revision comparison with text diffs exported together as a UTF-8 file.'),
	], 'Revision comparison context with either both inline diffs or one file containing both diffs.'),
	list_conflicts: object({
		accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
		items: {
			type: 'array',
			items: object({
				id: { type: 'string', description: 'Native id of the conflict note.' },
				title: { type: 'string', description: 'Title of the conflict note.' },
				conflict_original_id: { type: 'string', description: 'Original note id, or an empty string when no original is linked.' },
				created_time: { type: 'number', description: 'Note creation time in Joplin millisecond timestamp format.' },
				updated_time: { type: 'number', description: 'Note update time in Joplin millisecond timestamp format.' },
			}),
			description: 'Current conflict note rows on this page, newest first.',
		},
		hasMore: { type: 'boolean', description: 'Whether another readable conflict exists after this page.' },
	}),
	read_conflict: object({
		accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
		conflict: { ...conflictSideSchema, description: 'Conflict copy and its current availability on this device.' },
		original: { ...originalSideSchema, description: 'Linked original note and its current availability, or an unlinked state.' },
	}),
};
