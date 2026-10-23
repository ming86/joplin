/** Build a closed output object for a fixed Trash result shape. */
const object = (properties, required = Object.keys(properties), description) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
	...(description ? { description } : {}),
});

/** Authenticated Joplin profile email supplied by the root MCP presenter. */
const accountEmail = { type: ['string', 'null'], description: 'Authenticated Joplin account email, or null when unavailable.' };
/** Native Joplin note or notebook identifier. */
const id = { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Native Joplin note or notebook identifier.' };
/** Parent notebook id, with an empty string denoting the notebook root. */
const parentId = { type: 'string', description: 'Parent notebook id; an empty string denotes the notebook root.' };
/** Compact metadata shared by deleted notes and notebooks. */
const trashItemProperties = {
	id,
	type: { type: 'string', enum: ['note', 'notebook'], description: 'Whether this Trash item is a note or notebook.' },
	title: { type: 'string', description: 'Native display title, including the native masked title when encrypted.' },
	parent_id: parentId,
	deleted_time: { type: 'integer', minimum: 1, description: 'Deletion time in Unix epoch milliseconds.' },
	updated_time: { type: 'integer', minimum: 0, description: 'Last update time in Unix epoch milliseconds.' },
};
/** Note rows retain the native conflict flag; notebook rows do not have one. */
const trashItem = {
	oneOf: [
		object({ ...trashItemProperties, type: { const: 'note', description: 'This Trash item is a note.' }, is_conflict: { type: 'integer', enum: [0, 1], description: 'Native conflict flag, encoded as 0 or 1.' } }),
		object({ ...trashItemProperties, type: { const: 'notebook', description: 'This Trash item is a notebook.' } }, undefined, 'Notebook row without a note conflict flag.'),
	],
};

/** Success output schemas for native Joplin Trash tools. */
export const trashOutputSchemas = {
	list_trash: object({
		accountEmail,
		items: { type: 'array', items: trashItem, description: 'Deleted note and notebook rows on this page, ordered by deletion time descending, then type and id.' },
		hasMore: { type: 'boolean', description: 'Whether another Trash item exists after this page.' },
	}),
	restore_note: object({
		accountEmail,
		id,
		parent_id: parentId,
		restored: { type: 'boolean', const: true, description: 'Confirms the deleted note was restored.' },
	}, undefined, 'Restored note and its resulting notebook parent.'),
	restore_notebook: object({
		accountEmail,
		id,
		parent_id: parentId,
		restored: { type: 'boolean', const: true, description: 'Confirms the deleted notebook subtree was restored.' },
	}, undefined, 'Restored notebook subtree root and its resulting notebook parent.'),
};
