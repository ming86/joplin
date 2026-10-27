import { ServiceError, identifier, pagination, requireValue } from './errors.mjs';

/** Recognize plain input and backend records. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate a native Joplin revision identifier. */
const revisionId = value => {
	requireValue(typeof value === 'string' && /^[a-f0-9]{32}$/.test(value), 'invalid_revision_id');
	return value;
};

/** Keep the account's existing decrypted, unlocked note boundary for live reads. */
function readable(note, id) {
	if (!note || note.id !== id || note.encryption_applied !== 0 || note.deleted_time || note.is_locked) {
		throw new ServiceError('note_unavailable');
	}
	return note;
}

/** Validate public MCP changes while leaving their semantics to the atomic core operation. */
function noteChanges(input) {
	requireValue(record(input), 'invalid_note_input');
	const allowed = ['title', 'body', 'body_patch', 'append', 'prepend', 'replace_text', 'notebook_id', 'is_todo', 'todo_due', 'todo_completed', 'source_url'];
	requireValue(Object.keys(input).every(key => allowed.includes(key)), 'unsupported_note_property');
	requireValue(Object.keys(input).length > 0, 'empty_note_update');
	for (const key of ['title', 'body', 'body_patch', 'append', 'prepend']) {
		if (Object.hasOwn(input, key)) requireValue(typeof input[key] === 'string', 'invalid_note_input');
	}
	if (Object.hasOwn(input, 'notebook_id')) identifier(input.notebook_id);
	if (Object.hasOwn(input, 'is_todo')) requireValue(typeof input.is_todo === 'boolean', 'invalid_note_input');
	if (Object.hasOwn(input, 'todo_due')) requireValue(Number.isInteger(input.todo_due), 'invalid_note_input');
	if (Object.hasOwn(input, 'todo_completed')) requireValue(typeof input.todo_completed === 'boolean', 'invalid_note_input');
	if (Object.hasOwn(input, 'source_url')) requireValue(typeof input.source_url === 'string', 'invalid_note_input');
	if (Object.hasOwn(input, 'replace_text')) {
		const replace = input.replace_text;
		requireValue(record(replace) && Object.keys(replace).length === 2
			&& Object.hasOwn(replace, 'find') && Object.hasOwn(replace, 'replace')
			&& typeof replace.find === 'string' && typeof replace.replace === 'string', 'invalid_note_input');
	}
	return structuredClone(input);
}

/** Validate combined revision selectors and pagination at the account service boundary. */
function listRevisionsInput(input) {
	requireValue(record(input) && Object.keys(input).every(key => [
		'note_ids', 'notebook_ids', 'include_descendants', 'since', 'until', 'page', 'limit',
	].includes(key)), 'invalid_revision_input');
	const result = {};
	for (const key of ['note_ids', 'notebook_ids']) {
		if (input[key] === undefined) continue;
		requireValue(Array.isArray(input[key]), 'invalid_revision_input');
		result[key] = input[key].map(identifier);
	}
	if (input.include_descendants !== undefined) {
		requireValue(typeof input.include_descendants === 'boolean', 'invalid_revision_input');
		result.include_descendants = input.include_descendants;
	}
	for (const key of ['since', 'until']) {
		if (input[key] === undefined) continue;
		requireValue(Number.isSafeInteger(input[key]), 'invalid_revision_input');
		result[key] = input[key];
	}
	const page = input.page === undefined ? 1 : input.page;
	const limit = input.limit === undefined ? 20 : input.limit;
	requireValue(Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(limit) && limit >= 1
		&& Number.isSafeInteger(limit + 1), 'invalid_pagination');
	const offset = (page - 1) * limit;
	requireValue(Number.isSafeInteger(offset) && Number.isSafeInteger(offset + limit + 1), 'invalid_pagination');
	result.page = page;
	result.limit = limit;
	return result;
}

/** Create an account-bound adapter for live note reads and immutable native history. */
export function createRevisionService({ backend, permit, accountId, readableNotebookTitle }) {
	requireValue(typeof backend === 'function' && typeof permit === 'function'
		&& typeof accountId === 'string' && accountId.length > 0 && typeof readableNotebookTitle === 'function');
	/** Attach the account identity without changing source fields. */
	const identity = value => ({ ...value, accountId });
	/** Resolve the lazily created backend once for each service operation. */
	const core = () => {
		const value = backend();
		requireValue(value && typeof value === 'object');
		return value;
	};

	return Object.freeze({
		/** Read an eligible note together with the native revision used as its update base. */
		async readNoteWithRevision(id, signal) {
			permit('read');
			identifier(id);
			const client = core();
			const note = readable(await client.readNoteWithRevision(id, signal), id);
			const notebook_title = note.parent_id ? await readableNotebookTitle(note.parent_id, signal) : null;
			const tags = await client.getNoteTags(id, signal);
			return identity({ ...note, notebook_title, tags: tags.map(tag => tag.title) });
		},
		/** Apply the exact public MCP change with its required native revision precondition. */
		async updateNoteWithRevision(id, input, signal) {
			permit('write');
			identifier(id);
			requireValue(record(input) && Object.hasOwn(input, 'base_revision_id'), 'base_revision_required');
			const { base_revision_id: baseRevisionId, ...rawChanges } = input;
			revisionId(baseRevisionId);
			const changes = noteChanges(rawChanges);
			return identity(await core().updateNoteWithRevision(id, { base_revision_id: baseRevisionId, ...changes }, signal));
		},
		/** List native revisions. This remains available after the live note is deleted. */
		async listNoteRevisions(input, signal) {
			permit('read');
			requireValue(record(input) && Object.keys(input).every(key => ['note_id', 'page', 'limit'].includes(key)), 'invalid_revision_input');
			const noteId = identifier(input.note_id);
			const page = pagination({ page: input.page, limit: input.limit });
			const result = await core().listNoteRevisions({ note_id: noteId, ...page }, signal);
			return { accountId, ...result, items: result.items.map(identity) };
		},
		/** List retained revisions across the selected native note and notebook scopes. */
		async listRevisions(input = {}, signal) {
			permit('read');
			const args = listRevisionsInput(input);
			const result = await core().listRevisions(args, signal);
			return { accountId, ...result };
		},
		/** Read an immutable historical snapshot without requiring the live note to exist. */
		async readNoteRevision(input, signal) {
			permit('read');
			requireValue(record(input) && Object.keys(input).length === 2
				&& Object.hasOwn(input, 'note_id') && Object.hasOwn(input, 'revision_id'), 'invalid_revision_input');
			const noteId = identifier(input.note_id);
			const id = revisionId(input.revision_id);
			return identity(await core().readNoteRevision({ note_id: noteId, revision_id: id }, signal));
		},
		/** Compare immutable snapshots without first loading or validating the live note. */
		async compareNoteRevisions(input, signal) {
			permit('read');
			requireValue(record(input) && Object.keys(input).every(key => ['note_id', 'from_revision_id', 'to_revision_id'].includes(key))
				&& Object.hasOwn(input, 'note_id') && Object.hasOwn(input, 'from_revision_id'), 'invalid_revision_input');
			const noteId = identifier(input.note_id);
			const fromId = revisionId(input.from_revision_id);
			const toId = input.to_revision_id === undefined ? undefined : revisionId(input.to_revision_id);
			return identity(await core().compareNoteRevisions({
				note_id: noteId,
				from_revision_id: fromId,
				...(toId === undefined ? {} : { to_revision_id: toId }),
			}, signal));
		},
	});
}
