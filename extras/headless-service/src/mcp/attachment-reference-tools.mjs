/** MCP schema for native 32-character Joplin identifiers. */
const id = { type: 'string', pattern: '^[a-f0-9]{32}$' };
/** MCP schema for the service's supported page-number range. */
const page = { type: 'integer', minimum: 1, maximum: 1000000 };
/** MCP schema for one reference page, matching the sidecar's existing page-size range. */
const limit = { type: 'integer', minimum: 1, maximum: 100, default: 20 };
/** Build a closed input object so callers cannot add backend selectors. */
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
/** MCP annotations for read-only reference inspection. */
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Register the read-only MCP tool for current-body attachment references. */
export function registerAttachmentReferenceTools(add, service) {
	add('list_attachment_notes',
		'List notes whose current saved bodies refer to an attachment. This checks note bodies directly, including notes in Trash and conflict copies, and does not depend on the asynchronous attachment-reference index. It returns note metadata only and downloads no resource bytes. deleted_time indicates trashed notes and is_conflict marks conflict copies; encrypted or locked notes are omitted. Repeated links to the attachment within one note produce one row.',
		object({
			id: { ...id, description: 'The Joplin attachment id whose current note references to list.' },
			page: { ...page, description: 'Page number. Defaults to 1.' },
			limit: { ...limit, description: 'Maximum notes to return per page. Defaults to 20.' },
		}, ['id']),
		(args, signal) => service.listAttachmentNotes({ id: args.id, page: args.page, limit: args.limit ?? 20 }, signal),
		readAnnotations,
	);
}
