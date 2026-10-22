const id = {
	type: 'string',
	pattern: '^[a-f0-9]{32}$',
	description: 'Joplin item id.',
};

const object = (properties, required, description) => ({
	type: 'object',
	description,
	properties,
	required,
	additionalProperties: false,
});

const notebook = {
	id: { ...id, description: 'Joplin notebook id.' },
	title: { type: 'string', description: 'Notebook title.' },
	parent_id: {
		anyOf: [{ type: 'string' }, { type: 'null' }],
		description: 'Parent notebook id, or null for a top-level notebook.',
	},
	accountId: { type: 'string', description: 'Account that owns the notebook.' },
};

const tag = {
	id: { ...id, description: 'Joplin tag id.' },
	title: { type: 'string', description: 'Tag title.' },
	accountId: { type: 'string', description: 'Account that owns the tag.' },
};

const attachment = {
	id: { ...id, description: 'Joplin resource id.' },
	accountId: { type: 'string', description: 'Account that owns the resource.' },
	filename: { type: 'string', description: 'Pathless display filename, when supplied by Joplin.' },
	title: {
		anyOf: [{ type: 'string' }, { type: 'null' }],
		description: 'Display title when set; null when Joplin explicitly returns no title.',
	},
	mime: {
		anyOf: [{ type: 'string' }, { type: 'null' }],
		description: 'MIME type when set; null when Joplin explicitly returns no MIME type.',
	},
	file_extension: {
		anyOf: [{ type: 'string' }, { type: 'null' }],
		description: 'Resource filename extension, which may be an empty string when there is no extension.',
	},
	size: { type: 'number', description: 'Stored resource size in bytes.' },
	created_time: { type: 'number', description: 'Creation time as Unix epoch milliseconds.' },
	updated_time: { type: 'number', description: 'Last update time as Unix epoch milliseconds.' },
	encryption_applied: {
		type: 'integer',
		enum: [0, 1],
		description: 'Whether Joplin encrypted the resource metadata: 0 for no, 1 for yes.',
	},
	encryption_blob_encrypted: {
		type: 'integer',
		enum: [0, 1],
		description: 'Whether Joplin encrypted the resource file bytes: 0 for no, 1 for yes.',
	},
	is_locked: {
		type: 'integer',
		enum: [0, 1],
		description: 'Whether Joplin currently considers the resource locked: 0 for no, 1 for yes.',
	},
};

const attachmentRequired = ['id', 'accountId'];

/** Success output schemas for maintenance and attachment tools' structuredContent. */
export const maintenanceAttachmentOutputSchemas = {
	update_notebook: object(notebook, ['id', 'title', 'parent_id', 'accountId'], 'The updated notebook and its owning account.'),
	delete_notebook: object({
		id: { ...id, description: 'Notebook id moved to Joplin Trash.' },
		trashed: { const: true, description: 'True after Joplin moves the notebook subtree to Trash.' },
		accountId: { type: 'string', description: 'Account that owns the notebook.' },
	}, ['id', 'trashed', 'accountId'], 'Confirmation that the notebook subtree was moved to Joplin Trash.'),
	create_tag: object(tag, ['id', 'title', 'accountId'], 'The created tag and its owning account.'),
	rename_tag: object(tag, ['id', 'title', 'accountId'], 'The renamed tag and its owning account.'),
	list_note_attachments: object({
		note_id: { ...id, description: 'Note whose linked attachments were listed.' },
		attachments: {
			type: 'array',
			description: 'All attachment metadata linked to the note; the service follows every Joplin API page.',
			items: object(attachment, attachmentRequired, 'Metadata for one linked Joplin resource.'),
		},
	}, ['note_id', 'attachments'], 'The note id and complete list of linked attachment metadata.'),
	read_attachment: object({
		...attachment,
		filename: { type: 'string', description: 'Pathless display filename for the resource.' },
		uri: {
			type: 'string',
			description: 'Stable joplin-resource URI for the embedded file bytes, with the filename URL-encoded.',
		},
	}, ['id', 'accountId', 'filename', 'uri'], 'Readable attachment metadata. The file bytes are returned separately as an embedded MCP resource in content, not in structuredContent.'),
	create_attachment: object({
		...attachment,
		filename: { type: 'string', description: 'Pathless filename supplied for the uploaded resource.' },
		resource_id: { ...id, description: 'Joplin resource id; the same id is also returned in id.' },
		markdown_link: { type: 'string', description: 'Joplin Markdown link that can be inserted into a note body to link this resource.' },
	}, ['id', 'accountId', 'filename', 'resource_id', 'markdown_link'], 'The created standalone resource metadata, its resource id, and a Markdown link.'),
	update_attachment: object(attachment, attachmentRequired, 'The updated attachment metadata and its owning account.'),
};
