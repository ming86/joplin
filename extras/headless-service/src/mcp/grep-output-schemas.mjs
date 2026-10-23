/** Build a closed object schema for fixed result records. */
const object = (properties, required = Object.keys(properties), description) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
	...(description ? { description } : {}),
});

/** One matched or surrounding source line, with lengths measured in UTF-16 code units. */
const line = object({
	line_number: { type: 'integer', minimum: 1, description: 'One-based line number in the exact note body searched.' },
	text: { type: 'string', description: 'Line text without its CR, LF, or CRLF delimiter. May be clipped when max_line_chars was supplied.' },
	truncated: { type: 'boolean', description: 'True only when text was clipped by max_line_chars.' },
	line_length: { type: 'integer', minimum: 0, description: 'Original line length in UTF-16 code units before optional clipping.' },
}, undefined, 'One source line from a matched note body.');

/** One matching source line and its exact native note revision. */
const match = object({
	note_id: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Joplin note id.' },
	title: { type: 'string', description: 'Note title from the same revision as the searched body.' },
	notebook_id: { type: ['string', 'null'], description: 'Containing notebook id, or null when the note has no notebook.' },
	revision_id: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Native revision id for the exact note body searched. Pass this as base_revision_id to update_note.' },
	line_number: { type: 'integer', minimum: 1, description: 'One-based source line number containing the match.' },
	text: { type: 'string', description: 'Matching line text without its CR, LF, or CRLF delimiter. May be clipped by max_line_chars.' },
	truncated: { type: 'boolean', description: 'True only when text was clipped by max_line_chars.' },
	line_length: { type: 'integer', minimum: 0, description: 'Original matching line length in UTF-16 code units before optional clipping.' },
	context_before: { type: 'array', description: 'Requested source lines immediately before the match in source order; empty when context_before is 0.', items: line },
	context_after: { type: 'array', description: 'Requested source lines immediately after the match in source order; empty when context_after is 0.', items: line },
}, undefined, 'One matching source line and surrounding source lines from the exact note revision searched.');

/** Success output schema for grep_notes structuredContent. */
export const grepOutputSchemas = {
	grep_notes: object({
		accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
		items: { type: 'array', description: 'Matching source lines ordered by note id and then line number; each matching line appears once.', items: match },
		page: { type: 'integer', minimum: 1, description: 'Page number among matching source lines.' },
		limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum number of matching source lines requested for this page.' },
		hasMore: { type: 'boolean', description: 'Whether at least one additional matching source line exists after this page.' },
	}, ['accountEmail', 'items', 'page', 'limit', 'hasMore'], 'Matching note lines with their source revisions and authenticated account email.'),
};
