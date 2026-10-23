/** MCP schema for native 32-character Joplin IDs. */
const id = { type: 'string', pattern: '^[a-f0-9]{32}$' };
/** MCP schema for the existing page-number range. */
const page = { type: 'integer', minimum: 1, maximum: 1000000 };
/** MCP schema for the headless API's page-size range and list default. */
const limit = { type: 'integer', minimum: 1, maximum: 100, default: 20 };
/** Build closed tool inputs so callers cannot add unrecognized selectors. */
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
/** MCP annotations for a read that does not change the Trash. */
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Restore requests write state but recover the item rather than removing data. */
const restoreAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Register Trash inspection and optional restore tools. */
export function registerTrashTools(add, service, { allowWrites = true } = {}) {
	add('list_trash',
		'List deleted notes and notebooks in the Joplin Trash, newest first. Returns metadata only, including conflict copies and locked items. Encrypted titles use Joplin\'s masked display title.',
		object({
			page: { ...page, description: 'Page number. Defaults to 1.' },
			limit: { ...limit, description: 'Maximum Trash items to return per page. Defaults to 20.' },
		}),
		(args, signal) => service.listTrash({ page: args.page, limit: args.limit ?? 20 }, signal),
		readAnnotations,
	);

	if (allowWrites) {
		add('restore_note',
			'Restore one deleted note from the Trash. The note returns to its original notebook when that notebook exists and is not in Trash; otherwise Joplin restores it at the notebook root. The note keeps its ID and existing history.',
			object({ id: { ...id, description: 'The deleted note id returned by list_trash.' } }, ['id']),
			(args, signal) => service.restoreNote({ id: args.id }, signal),
			restoreAnnotations,
		);

		add('restore_notebook',
			'Restore one deleted notebook from the Trash, including its deleted descendant notebooks and notes. The notebook returns to its original parent when that parent exists and is not in Trash; otherwise Joplin restores it at the notebook root. Restored items keep their IDs.',
			object({ id: { ...id, description: 'The deleted notebook id returned by list_trash.' } }, ['id']),
			(args, signal) => service.restoreNotebook({ id: args.id }, signal),
			restoreAnnotations,
		);
	}
}
