import Folder from '@joplin/lib/models/Folder';
import type { FolderEntity } from '@joplin/lib/services/database/types';

/** The only account-facing fields accepted by the private notebook update action. */
interface NotebookMaintenanceInput {
	id: string;
	title?: string;
	parent_id?: string;
}

/** Throw a bounded validation error when a fixed maintenance action input is invalid. */
function requireValue(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Load a real, active and decrypted notebook rather than a virtual Trash or Conflicts folder. */
async function loadAvailableNotebook(id: string): Promise<FolderEntity> {
	const notebook = await Folder.load(id, {
		fields: ['id', 'title', 'parent_id', 'deleted_time', 'encryption_applied'],
	});
	requireValue(notebook && notebook.id === id && !(notebook.deleted_time > 0) && notebook.encryption_applied === 0, 'Notebook unavailable.');
	return notebook;
}

/** Update a notebook through model APIs so native validation and move rules remain in effect. */
async function updateNotebook(input: NotebookMaintenanceInput) {
	requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Invalid notebook update.');
	requireValue(Object.keys(input).every(key => ['id', 'title', 'parent_id'].includes(key)), 'Unsupported notebook property.');
	requireValue(typeof input.id === 'string' && /^[a-f0-9]{32}$/.test(input.id), 'Invalid notebook id.');
	const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title');
	const hasParent = Object.prototype.hasOwnProperty.call(input, 'parent_id');
	requireValue(hasTitle || hasParent, 'Notebook update is empty.');
	if (hasTitle) requireValue(typeof input.title === 'string', 'Invalid notebook title.');
	if (hasParent) requireValue(typeof input.parent_id === 'string', 'Invalid notebook parent id.');

	const current = await loadAvailableNotebook(input.id);
	if (hasParent && input.parent_id) await loadAvailableNotebook(input.parent_id);
	if (hasParent) {
		requireValue(await Folder.canNestUnder(input.id, input.parent_id), 'Cannot move notebook to this location.');
	}

	// Validate and save the title before moving so a title rejection leaves the tree unchanged.
	if (hasTitle) await Folder.save({ id: input.id, title: input.title }, { userSideValidation: true });
	if (hasParent) await Folder.moveToFolder(input.id, input.parent_id);

	const updated = hasParent ? await loadAvailableNotebook(input.id) : await Folder.load(input.id, {
		fields: ['id', 'title', 'parent_id'],
	});
	requireValue(updated && updated.id === input.id, 'Notebook unavailable.');
	return { id: input.id, title: updated.title ?? current.title ?? '', parent_id: updated.parent_id ?? '' };
}

/** Return the one native maintenance action accepted by the headless status service. */
export function createHeadlessMaintenanceActions() {
	return Object.assign(Object.create(null), {
		maintenanceUpdateNotebook: updateNotebook,
	});
}
