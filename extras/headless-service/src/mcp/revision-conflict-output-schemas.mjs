/** Build a closed object schema for the fixed result records. */
const object = (properties, required = Object.keys(properties)) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
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
	body_length: { type: 'integer', description: 'Total body length in UTF-16 code units.' },
	body_offset: { type: 'integer', description: 'Actual body start offset in UTF-16 code units, adjusted to avoid splitting a surrogate pair.' },
	body_returned_chars: { type: 'integer', description: 'Number of body UTF-16 code units returned.' },
	has_more: { type: 'boolean', description: 'Whether more body content follows this chunk.' },
	offset: { type: 'integer', description: 'Actual body start offset in UTF-16 code units; matches body_offset.' },
	nextOffset: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Next UTF-16 code-unit offset, or null when the full body has been returned.' },
	totalLength: { type: 'integer', description: 'Total body length in UTF-16 code units; matches body_length.' },
	offsetUnit: { const: 'utf16-code-unit', description: 'Unit used by the body offsets and lengths.' },
};

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

/** Allowlisted current note fields included when a conflict side is available. */
const conflictSnapshot = object({
	id: { type: 'string', description: 'Native note identifier.' },
	parent_id: { type: 'string', description: 'Parent notebook identifier; an empty string denotes the root.' },
	title: { type: 'string', description: 'Current note title.' },
	body: { type: 'string', description: 'Current note body in its native markup format.' },
	created_time: { type: 'number', description: 'Note creation time in Joplin millisecond timestamp format.' },
	updated_time: { type: 'number', description: 'Note update time in Joplin millisecond timestamp format.' },
	is_todo: { type: 'number', description: 'Native to-do flag, encoded numerically as 0 or 1.' },
	todo_completed: { type: 'number', description: 'To-do completion time in milliseconds, or 0 while open.' },
	markup_language: { type: 'number', description: 'Native markup language identifier.' },
	is_conflict: { type: 'number', description: 'Native conflict flag, encoded numerically as 0 or 1.' },
	conflict_original_id: { type: 'string', description: 'Original note identifier, or an empty string when unlinked.' },
	...bodyChunkProperties,
});

/** Create the status-specific result schema for one conflict side. */
function conflictSide(statuses, idSchema) {
	return {
		oneOf: [
			object({
				id: idSchema,
				status: { const: 'available', description: 'The side is readable on this device.' },
				note: { ...conflictSnapshot, description: 'Current note snapshot with a UTF-16-safe body chunk.' },
			}),
			...statuses.map(status => object({
				id: idSchema,
				status: { const: status, description: 'Why the side has no readable note content.' },
			})),
		],
	};
}

const stringId = { type: 'string', description: 'Native note identifier.' };
const conflictSideSchema = conflictSide(['trashed', 'encrypted', 'locked'], stringId);
const originalSideSchema = conflictSide(['missing', 'trashed', 'encrypted', 'locked'], stringId);
originalSideSchema.oneOf.push(object({
	id: { type: 'null', description: 'No original note is linked to this conflict.' },
	status: { const: 'unlinked', description: 'The conflict has no linked original note.' },
}));

/** Success output JSON Schemas for the native revision and conflict MCP tools. */
export const revisionConflictOutputSchemas = {
	list_note_revisions: object({
		accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
		items: { type: 'array', items: revisionSummary, description: 'Revision rows on this page, newest first.' },
		hasMore: { type: 'boolean', description: 'Whether another visible revision exists after this page.' },
	}),
	read_note_revision: object({
		note_id: { type: 'string', description: 'Original note identifier, including when the live note has been deleted.' },
		revision_id: { type: 'string', description: 'Native Joplin revision identifier.' },
		captured_time: { type: 'number', description: 'Revision capture time in Unix epoch milliseconds.' },
		title: { type: 'string', description: 'Historical note title.' },
		body: { type: 'string', description: 'Historical note body in its original markup format; may be a chunk.' },
		metadata: {
			type: 'object',
			additionalProperties: jsonValueSchema,
			description: 'JSON-safe tracked metadata from the historical note.',
		},
		accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
		...bodyChunkProperties,
	}),
	compare_note_revisions: object({
		accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
		note_id: { type: 'string', description: 'Original note identifier.' },
		from_revision_id: { type: 'string', description: 'Native revision identifier used as the comparison base.' },
		to_revision_id: { type: 'string', description: 'Native destination revision identifier, also returned when the current live state was captured.' },
		to_current: { type: 'boolean', description: 'True when the destination was captured from the current live note during this request.' },
		title_diff: { type: 'string', description: 'Unified title patch, or an empty string when unchanged.' },
		body_diff: { type: 'string', description: 'Unified body patch, or an empty string when unchanged.' },
		metadata_changes: { type: 'array', items: metadataChange, description: 'Tracked metadata changes, sorted by field name.' },
	}),
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
