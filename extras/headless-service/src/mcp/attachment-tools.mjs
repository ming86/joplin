import { ServiceError } from '../errors.mjs';
import { readBinaryFile } from './note-file-input.mjs';

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

/** Build a native MCP result with metadata text followed by embedded resources. */
export function embeddedResourcesResult(metadata, resourcesArray) {
	const result = {
		content: [
			{ type: 'text', text: JSON.stringify(metadata) },
			...resourcesArray.map(resource => ({ type: 'resource', resource })),
		],
		structuredContent: metadata,
		isError: false,
	};
	Object.defineProperty(result, nativeResult, { value: true });
	return result;
}

/** Build a native MCP result with metadata text and one embedded resource. */
export function embeddedResourceResult(metadata, uri, mimeType, blob) {
	return embeddedResourcesResult(metadata, [{ uri, mimeType, blob }]);
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

/** Describe the downloadable binary file reference supplied by the client. */
const contentFile = {
	...object({
		download_url: { type: 'string', minLength: 1, description: 'Public HTTPS download URL supplied for the binary file.' },
		file_id: { type: 'string', minLength: 1, description: 'File id supplied by the client.' },
		mime_type: { type: 'string', description: 'Optional file MIME type supplied by the client.' },
		file_name: { type: 'string', description: 'Optional file name supplied by the client.' },
	}, ['download_url', 'file_id']),
	description: 'Complete binary file to upload. Use content_file for binary or large files; do not combine it with content_base64.',
};

/** Require one source and reserve its base64 representation before encoding or starting a native write. */
async function attachmentContent(args, readFile, signal, requestPayload) {
	const hasBase64 = Object.hasOwn(args, 'content_base64');
	const hasFile = Object.hasOwn(args, 'content_file');
	if (hasBase64 && hasFile) throw new ServiceError('attachment_content_conflict');
	if (!hasBase64 && !hasFile) throw new ServiceError('attachment_content_required');
	if (hasBase64) return args.content_base64;
	const bytes = await readFile(args.content_file, signal, requestPayload);
	requestPayload?.reserve(4 * Math.ceil(bytes.length / 3));
	return bytes.toString('base64');
}

/** Add attachment tools to the caller's fixed catalog, reusing its argument validation and error handling. */
export function registerAttachmentTools(add, service, { allowWrites = false, readFile = readBinaryFile } = {}) {
	add('list_note_attachments', 'List attachment metadata linked to a readable note. Encrypted or locked notes are unavailable.', object({
		note_id: { ...attachmentId, description: 'The readable note id whose attachments should be listed.' },
	}, ['note_id']), async ({ note_id }, signal) => ({
		note_id,
		attachments: await service.listNoteAttachments(note_id, signal),
	}));

	add('read_attachment', 'Read a readable, unlocked attachment by resource id. Returns resource metadata and the file bytes as an embedded MCP resource.', object({
		id: { ...attachmentId, description: 'The Joplin resource id.' },
	}, ['id']), async ({ id }, signal, context = {}) => {
		const attachment = await service.readAttachment(id, signal, context.responsePayload);
		const metadata = {
			...attachment,
			uri: resourceUri(attachment.id, attachment.filename),
		};
		delete metadata.contentBase64;
		return embeddedResourceResult(metadata, metadata.uri, resourceMime(attachment), attachment.contentBase64);
	});

	if (allowWrites) {
		const createSchema = object({
			filename: { type: 'string', description: 'Filename to store for the resource.', minLength: 1 },
			content_base64: { type: 'string', description: 'Complete file contents encoded as standard base64. Use content_file for binary or large files.', pattern: base64 },
			content_file: contentFile,
			title: { type: 'string', description: 'Optional display title for the resource.' },
			mime: { type: 'string', description: 'Optional MIME type.' },
		}, ['filename']);
		createSchema.anyOf = [{ required: ['content_base64'] }, { required: ['content_file'] }];
		createSchema.not = { required: ['content_base64', 'content_file'] };
		add('create_attachment', 'Upload a file as a standalone Joplin resource. Use content_file for binary or large files; content_base64 remains available for inline data. Do not combine the two content sources. Returns its resource id and a Markdown link; attach it to a note by inserting the link with update_note.', createSchema, async (args, signal, context = {}) => {
			const contentBase64 = await attachmentContent(args, readFile, signal, context.requestPayload);
			const { filename, title, mime } = args;
			const attachment = await service.createAttachment({ filename, contentBase64, title, mime }, signal);
			return {
				...attachment,
				resource_id: attachment.id,
				filename,
				markdown_link: markdownLink(filename, attachment.id),
			};
		}, createAnnotations, { 'openai/fileParams': ['content_file'] });

		const updateSchema = object({
			id: { ...attachmentId, description: 'The Joplin resource id to update.' },
			title: { type: 'string', description: 'New display title.' },
			filename: { type: 'string', description: 'New filename; Joplin updates the resource title and file extension.', minLength: 1 },
			mime: { type: 'string', description: 'New MIME type.' },
			content_base64: { type: 'string', description: 'Complete replacement file contents encoded as standard base64. Use content_file for binary or large files.', pattern: base64 },
			content_file: contentFile,
		}, ['id']);
		updateSchema.minProperties = 2;
		updateSchema.not = { required: ['content_base64', 'content_file'] };
		add('update_attachment', 'Rename or replace a readable, unlocked attachment. Use content_file for binary or large replacements; content_base64 remains available for inline data. Do not combine the two content sources. Replacing file bytes changes the current resource; Joplin note history does not preserve the previous binary contents.', updateSchema,
			async (args, signal, context = {}) => {
				const hasBase64 = Object.hasOwn(args, 'content_base64');
				const hasFile = Object.hasOwn(args, 'content_file');
				if (hasBase64 && hasFile) throw new ServiceError('attachment_content_conflict');
				const { id, title, filename, mime } = args;
				const contentBase64 = hasFile ? await attachmentContent(args, readFile, signal, context.requestPayload) : args.content_base64;
				return service.updateAttachment(id, {
					...(title === undefined ? {} : { title }),
					...(filename === undefined ? {} : { filename }),
					...(mime === undefined ? {} : { mime }),
					...(contentBase64 === undefined ? {} : { contentBase64 }),
				}, signal);
			}, updateAnnotations, { 'openai/fileParams': ['content_file'] });
	}
}
