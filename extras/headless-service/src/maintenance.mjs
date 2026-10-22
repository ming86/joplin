import { ServiceError, requireValue, identifier } from './errors.mjs';

/** Require a JSON object without accepting arrays or values with no own fields. */
function inputRecord(value, code) {
	requireValue(value && typeof value === 'object' && !Array.isArray(value), code);
	return value;
}

/** Validate only the account-facing notebook fields; native Joplin validation handles their values. */
function notebookPatch(input) {
	inputRecord(input, 'invalid_notebook_input');
	requireValue(Object.keys(input).every(key => key === 'title' || key === 'parent_id'), 'unsupported_notebook_property');
	requireValue(Object.keys(input).length > 0, 'empty_notebook_update');
	const result = {};
	if (Object.hasOwn(input, 'title')) {
		requireValue(typeof input.title === 'string', 'invalid_notebook_input');
		result.title = input.title;
	}
	if (Object.hasOwn(input, 'parent_id')) {
		requireValue(typeof input.parent_id === 'string', 'invalid_notebook_input');
		if (input.parent_id) identifier(input.parent_id);
		result.parent_id = input.parent_id;
	}
	return result;
}

/** Bind notebook and tag maintenance to an already-authorized account and lazy backend factory. */
export function createMaintenanceService({ backend, permit, accountId }) {
	requireValue(typeof backend === 'function' && typeof permit === 'function'
		&& typeof accountId === 'string' && accountId.length > 0, 'invalid_configuration');
	const identity = value => ({ ...value, accountId });

	return Object.freeze({
		/** Update an available notebook's title, parent, or both. An empty parent id selects the root. */
		async updateNotebook(id, input, signal) {
			permit('write');
			const notebookId = identifier(id);
			const patch = notebookPatch(input);
			await backend().getNotebook(notebookId, signal);
			if (patch.parent_id) await backend().getNotebook(patch.parent_id, signal);
			return identity(await backend().updateNotebook(notebookId, patch, signal));
		},
		/** Move an available notebook subtree to Joplin Trash using its default folder-delete operation. */
		async deleteNotebook(id, signal) {
			permit('write');
			const notebookId = identifier(id);
			await backend().getNotebook(notebookId, signal);
			await backend().deleteNotebook(notebookId, signal);
			return { id: notebookId, trashed: true, accountId };
		},
		/** Create a standalone tag; note associations remain the responsibility of manage_tags. */
		async createTag(title, signal) {
			permit('write');
			requireValue(typeof title === 'string' && title.trim().length > 0, 'invalid_tag_input');
			return identity(await backend().createTag(title.trim(), signal));
		},
		/** Rename an available tag using Joplin's native title normalization and duplicate checks. */
		async renameTag(id, title, signal) {
			permit('write');
			const tagId = identifier(id);
			requireValue(typeof title === 'string', 'invalid_tag_input');
			await backend().getTag(tagId, signal);
			return identity(await backend().updateTag(tagId, { title }, signal));
		},
	});
}
