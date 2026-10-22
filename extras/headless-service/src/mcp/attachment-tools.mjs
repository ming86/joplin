const attachmentId = { type: 'string', pattern: '^[a-f0-9]{32}$' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const createAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const updateAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const base64 = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';
const nativeResult = Symbol('attachment_mcp_tool_result');

/** Identify an MCP result that already has content blocks and must pass through unchanged. */
export function isMcpToolResult(value) {
	return Boolean(value && typeof value === 'object' && value[nativeResult] === true);
}

/** Build a native MCP result with metadata text and binary bytes in one resource block. */
function embeddedResourceResult(metadata, uri, mimeType, blob) {
	const result = {
		content: [
			{ type: 'text', text: JSON.stringify(metadata) },
			{ type: 'resource', resource: { uri, mimeType, blob } },
		],
		structuredContent: metadata,
		isError: false,
	};
	Object.defineProperty(result, nativeResult, { value: true });
	return result;
}

/** Escape a filename for a Joplin Markdown link label. */
function markdownLink(filename, resourceId) {
	const label = filename.replace(/[\\\[\]\r\n]/g, character => {
		if (character === '\r' || character === '\n') return ' ';
		return `\\${character}`;
	});
	return `[${label}](:/${resourceId})`;
}

/** Give the returned blob a stable, filename-aware Joplin resource URI. */
function resourceUri(resourceId, filename) {
	return `joplin-resource://${resourceId}/${encodeURIComponent(filename)}`;
}

/** Use the stored MIME type, falling back when the backend has none. */
function resourceMime(attachment) {
	return typeof attachment.mime === 'string' && attachment.mime ? attachment.mime : 'application/octet-stream';
}

/** Add attachment tools to the caller's fixed catalog, reusing its argument validation and error handling. */
export function registerAttachmentTools(add, service, { allowWrites = false } = {}) {
	add('list_note_attachments', 'List attachment metadata linked to a readable note. Encrypted or locked notes are unavailable.', object({
		note_id: { ...attachmentId, description: 'The readable note id whose attachments should be listed.' },
	}, ['note_id']), async ({ note_id }, signal) => ({
		note_id,
		attachments: await service.listNoteAttachments(note_id, signal),
	}));

	add('read_attachment', 'Read a readable, unlocked attachment by resource id. Returns resource metadata and the file bytes as an embedded MCP resource.', object({
		id: { ...attachmentId, description: 'The Joplin resource id.' },
	}, ['id']), async ({ id }, signal) => {
		const attachment = await service.readAttachment(id, signal);
		const metadata = {
			...attachment,
			uri: resourceUri(attachment.id, attachment.filename),
		};
		delete metadata.contentBase64;
		return embeddedResourceResult(metadata, metadata.uri, resourceMime(attachment), attachment.contentBase64);
	});

	if (allowWrites) {
		add('create_attachment', 'Upload a file as a standalone Joplin resource. Returns its resource id and a Markdown link; attach it to a note by inserting the link with update_note.', object({
			filename: { type: 'string', description: 'Filename to store for the resource.', minLength: 1 },
			content_base64: { type: 'string', description: 'Complete file contents encoded as standard base64.', pattern: base64 },
			title: { type: 'string', description: 'Optional display title for the resource.' },
			mime: { type: 'string', description: 'Optional MIME type.' },
		}, ['filename', 'content_base64']), async ({ filename, content_base64, title, mime }, signal) => {
			const attachment = await service.createAttachment({ filename, contentBase64: content_base64, title, mime }, signal);
			return {
				...attachment,
				resource_id: attachment.id,
				filename,
				markdown_link: markdownLink(filename, attachment.id),
			};
		}, createAnnotations);

		const updateSchema = object({
			id: { ...attachmentId, description: 'The Joplin resource id to update.' },
			title: { type: 'string', description: 'New display title.' },
			filename: { type: 'string', description: 'New filename; Joplin updates the resource title and file extension.', minLength: 1 },
			mime: { type: 'string', description: 'New MIME type.' },
			content_base64: { type: 'string', description: 'Complete replacement file contents encoded as standard base64.', pattern: base64 },
		}, ['id']);
		updateSchema.anyOf = [{ required: ['title'] }, { required: ['filename'] }, { required: ['mime'] }, { required: ['content_base64'] }];
		add('update_attachment', 'Rename or replace a readable, unlocked attachment. Replacing file bytes changes the current resource; Joplin note history does not preserve the previous binary contents.', updateSchema,
			async ({ id, title, filename, mime, content_base64 }, signal) => service.updateAttachment(id, {
				...(title === undefined ? {} : { title }),
				...(filename === undefined ? {} : { filename }),
				...(mime === undefined ? {} : { mime }),
				...(content_base64 === undefined ? {} : { contentBase64: content_base64 }),
			}, signal), updateAnnotations);
	}
}
