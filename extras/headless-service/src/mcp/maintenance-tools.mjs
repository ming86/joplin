const id = { type: 'string', pattern: '^[a-f0-9]{32}$' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const createAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const updateAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const deleteAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** Add the fixed notebook and tag maintenance tools to the existing MCP catalog. */
export function registerMaintenanceTools(add, service) {
	const updateNotebookSchema = object({
		id: { ...id, description: 'The notebook id from list_notebooks.' },
		title: { type: 'string', description: 'Optional new notebook title. Joplin applies its normal title validation.' },
		parent_id: { type: 'string', pattern: '^(?:[a-f0-9]{32})?$', description: 'Optional destination notebook id. Use an empty string to move the notebook to the top level.' },
	}, ['id']);
	updateNotebookSchema.anyOf = [{ required: ['title'] }, { required: ['parent_id'] }];
	add('update_notebook', [
		'Change an available notebook title, parent notebook, or both. Use parent_id "" to move it to the top level.',
		'Joplin validates notebook names and nesting rules. A combined title and move update runs as native model operations and can be partially applied if a later operation fails.',
	].join(' '), updateNotebookSchema, async (args, signal) => service.updateNotebook(args.id, {
		...(Object.hasOwn(args, 'title') ? { title: args.title } : {}),
		...(Object.hasOwn(args, 'parent_id') ? { parent_id: args.parent_id } : {}),
	}, signal), updateAnnotations);

	add('delete_notebook', 'Move a notebook and its nested notebooks and notes to the trash. It can be restored from the trash.', object({
		id: { ...id, description: 'The notebook id from list_notebooks.' },
	}, ['id']), (args, signal) => service.deleteNotebook(args.id, signal), deleteAnnotations);

	add('create_tag', 'Create a standalone tag. Use manage_tags to attach it to notes.', object({
		title: { type: 'string', minLength: 1, description: 'The tag title. Joplin applies its normal title trimming and normalization.' },
	}, ['title']), (args, signal) => service.createTag(args.title, signal), createAnnotations);

	add('rename_tag', 'Rename an available tag by id. Joplin applies its normal title normalization and duplicate-name checks; existing note associations keep the same tag id.', object({
		id: { ...id, description: 'The tag id from list_tags.' },
		title: { type: 'string', description: 'The new tag title.' },
	}, ['id', 'title']), (args, signal) => service.renameTag(args.id, args.title, signal), updateAnnotations);
}
