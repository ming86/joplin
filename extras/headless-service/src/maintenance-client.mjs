import { ServiceError, requireValue, identifier } from './errors.mjs';

/** Validate the small notebook shape returned by the native headless action. */
function notebookResult(data) {
	requireValue(data && typeof data === 'object' && typeof data.id === 'string'
		&& /^[a-f0-9]{32}$/.test(data.id) && typeof data.title === 'string'
		&& (data.parent_id === undefined || typeof data.parent_id === 'string'), 'invalid_backend_response');
	return { id: data.id, title: data.title, parent_id: data.parent_id ?? '' };
}

/** Validate and allowlist tag fields returned by the Data API. */
function tagResult(data) {
	requireValue(data && typeof data === 'object' && typeof data.id === 'string'
		&& /^[a-f0-9]{32}$/.test(data.id) && typeof data.title === 'string'
		&& typeof data.encryption_applied === 'number' && Number.isFinite(data.encryption_applied), 'invalid_backend_response');
	return { id: data.id, title: data.title, encryption_applied: data.encryption_applied };
}

/** Make fixed maintenance calls over the authenticated Joplin Data API request function. */
export function createMaintenanceClient(request) {
	requireValue(typeof request === 'function');
	return Object.freeze({
		/** Update a notebook through native model logic so moves retain Joplin's nesting rules. */
		async updateNotebook(id, input, signal) {
			const notebookId = identifier(id);
			requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_notebook_input');
			requireValue(Object.keys(input).length > 0 && Object.keys(input).every(key => key === 'title' || key === 'parent_id'), 'unsupported_notebook_property');
			if (Object.hasOwn(input, 'title')) requireValue(typeof input.title === 'string', 'invalid_notebook_input');
			if (Object.hasOwn(input, 'parent_id')) {
				requireValue(typeof input.parent_id === 'string', 'invalid_notebook_input');
				if (input.parent_id) identifier(input.parent_id);
			}
			const data = await request('services/headless', {}, 'POST', {
				action: 'maintenanceUpdateNotebook', id: notebookId, ...input,
			}, signal);
			try {
				const notebook = notebookResult(data);
				requireValue(notebook.id === notebookId, 'invalid_backend_response');
				return notebook;
			} catch {
				throw new ServiceError('write_outcome_unknown', true);
			}
		},
		/** Use Joplin's default folder DELETE behavior, which recursively moves the subtree to Trash. */
		async deleteNotebook(id, signal) {
			await request(`folders/${identifier(id)}`, {}, 'DELETE', undefined, signal);
		},
		/** Read one tag while retaining encryption state for the account service's eligibility check. */
		async getTag(id, signal) {
			const tagId = identifier(id);
			const data = await request(`tags/${tagId}`, { fields: 'id,title,encryption_applied' }, 'GET', undefined, signal);
			const tag = tagResult(data);
			requireValue(tag.id === tagId, 'invalid_backend_response');
			requireValue(tag.encryption_applied === 0, 'tag_unavailable');
			return { id: tag.id, title: tag.title };
		},
		/** Rename one tag using Joplin's validated tag save route. */
		async updateTag(id, input, signal) {
			const tagId = identifier(id);
			requireValue(input && typeof input === 'object' && !Array.isArray(input)
				&& Object.keys(input).length === 1 && Object.hasOwn(input, 'title') && typeof input.title === 'string', 'invalid_tag_input');
			const data = await request(`tags/${tagId}`, {}, 'PUT', { title: input.title }, signal);
			try {
				const tag = tagResult(data);
				requireValue(tag.id === tagId, 'invalid_backend_response');
				return { id: tag.id, title: tag.title };
			} catch {
				throw new ServiceError('write_outcome_unknown', true);
			}
		},
	});
}
