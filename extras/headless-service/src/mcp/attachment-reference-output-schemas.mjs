/** Build a closed object schema for fixed result records. */
const object = (properties, required = Object.keys(properties), description) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
	...(description ? { description } : {}),
});

/** Native timestamps are Unix epoch milliseconds. */
const time = { type: 'integer', minimum: 0, description: 'Unix epoch milliseconds.' };
/** One compact note row returned for a current attachment reference. */
const reference = object({
	id: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Joplin note id.' },
	title: { type: 'string', description: 'Current note title.' },
	parent_id: { type: 'string', description: 'Parent notebook id, or an empty string when no notebook is set.' },
	created_time: { ...time, description: 'Note creation time as Unix epoch milliseconds.' },
	updated_time: { ...time, description: 'Last note update time as Unix epoch milliseconds.' },
	deleted_time: { ...time, description: 'Trash time as Unix epoch milliseconds, or 0 while the note is not trashed.' },
	is_conflict: { type: 'integer', enum: [0, 1], description: 'Native conflict-copy flag: 1 for a conflict copy, 0 otherwise.' },
}, undefined, 'Metadata for one note whose current body links to the attachment.');

/** Success output schema for list_attachment_notes structuredContent. */
export const attachmentReferenceOutputSchemas = {
	list_attachment_notes: object({
		attachment_id: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Attachment whose current note references were listed.' },
		accountEmail: { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' },
		items: { type: 'array', description: 'One row per matching note, ordered by note id ascending.', items: reference },
		hasMore: { type: 'boolean', description: 'Whether another page of references is available.' },
	}, ['attachment_id', 'accountEmail', 'items', 'hasMore'], 'Current-body note references for one attachment, with authenticated account identity.'),
};
