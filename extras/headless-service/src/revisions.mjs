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
	const allowed = ['title', 'body', 'append', 'prepend', 'replace_text', 'notebook_id', 'todo_completed'];
	requireValue(Object.keys(input).every(key => allowed.includes(key)), 'unsupported_note_property');
	requireValue(Object.keys(input).length > 0, 'empty_note_update');
	for (const key of ['title', 'body', 'append', 'prepend']) {
		if (Object.hasOwn(input, key)) requireValue(typeof input[key] === 'string', 'invalid_note_input');
	}
	if (Object.hasOwn(input, 'notebook_id')) identifier(input.notebook_id);
	if (Object.hasOwn(input, 'todo_completed')) requireValue(typeof input.todo_completed === 'boolean', 'invalid_note_input');
	if (Object.hasOwn(input, 'replace_text')) {
		const replace = input.replace_text;
		requireValue(record(replace) && Object.keys(replace).length === 2
			&& Object.hasOwn(replace, 'find') && Object.hasOwn(replace, 'replace')
			&& typeof replace.find === 'string' && typeof replace.replace === 'string', 'invalid_note_input');
	}
	return structuredClone(input);
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
