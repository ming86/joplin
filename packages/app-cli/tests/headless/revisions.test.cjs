const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');

/** Minimal typed service error used by the isolated native action harness. */
class JoplinError extends Error {
	/** Preserve the public service code for action error mapping. */
	constructor(message, code) { super(message); this.code = code; }
}

/** Load the fixed action boundary with observable note mutation and history services. */
function actionsFor(listRevisions, updateNote = async () => {}, createNoteWithRevision = async () => {}) {
	return load('packages/app-cli/app/headless/revisions.ts', {
		'@joplin/lib/JoplinError': JoplinError,
		'@joplin/lib/services/HeadlessNoteService': { readNote: async () => ({}), updateNote, createNoteWithRevision },
		'@joplin/lib/services/HeadlessRevisionHistory': { listRevisions },
	}).createHeadlessRevisionActions();
}

test('fixed action catalog forwards native creation and returns the committed snapshot', async () => {
	const input = { title: 'New', notebook_id: 'a'.repeat(32), body: '', is_todo: false, todo_due: -123, source_url: '' };
	const snapshot = { id: 'b'.repeat(32), title: input.title, parent_id: input.notebook_id, body: '', updated_time: 123, revision_id: 'c'.repeat(32) };
	const actions = actionsFor(async () => ({}), undefined, async value => { assert.equal(value, input); return snapshot; });
	assert.equal(Object.getPrototypeOf(actions), null);
	assert.deepEqual(Object.keys(actions).sort(), ['compareNoteRevisions', 'createNoteWithRevision', 'listNoteRevisions', 'listRevisions', 'readNote', 'readNoteRevision', 'updateNote'].sort());
	assert.equal(await actions.createNoteWithRevision(input), snapshot);
});

test('native creation returns known validation and permission failures as non-applied actions', async () => {
	for (const code of ['invalid_note_input', 'unsupported_note_property', 'notebook_unavailable', 'note_read_only', 'validation_error']) {
		const message = `Expected ${code}`;
		const actions = actionsFor(async () => ({}), undefined, async () => { throw new JoplinError(message, code); });
		assert.deepEqual(await actions.createNoteWithRevision({}), { error: { code, message, applied: false } });
	}
});

test('native creation preserves unknown failures rather than claiming the write was not applied', async () => {
	for (const error of [new Error('Response failed after persistence'), new JoplinError('Unknown persistence outcome', 'write_outcome_unknown')]) {
		const actions = actionsFor(async () => ({}), undefined, async () => { throw error; });
		await assert.rejects(actions.createNoteWithRevision({}), thrown => thrown === error);
	}
});

test('combined native history action accepts unbounded selectors, large limits and signed or empty time ranges', async () => {
	const calls = [];
	const actions = actionsFor(async input => { calls.push(input); return { items: [], page: 1, limit: input.limit ?? 20, hasMore: false }; });
	for (const input of [{}, { limit: 101 }, { note_ids: Array(1200).fill('a'.repeat(32)), notebook_ids: [], include_descendants: false }, { since: -100, until: -200 }, { since: 100, until: 100 }]) {
		assert.deepEqual(await actions.listRevisions(input), { items: [], page: 1, limit: input.limit ?? 20, hasMore: false });
		assert.equal(calls.at(-1), input);
	}
});

test('combined native history action rejects malformed input before querying and preserves typed errors', async () => {
	let calls = 0;
	const actions = actionsFor(async () => { calls++; throw new JoplinError('The notebook is unavailable.', 'notebook_unavailable'); });
	for (const input of [null, [], { extra: true }, { note_ids: null }, { note_ids: ['invalid'] }, { notebook_ids: 'invalid' }, { include_descendants: null }, { since: 1.5 }, { until: Infinity }, { page: 0 }, { page: null }, { limit: null }, { limit: 0 }, { limit: Number.MAX_SAFE_INTEGER }, { page: Number.MAX_SAFE_INTEGER, limit: 1 }, { page: Number.MAX_SAFE_INTEGER, limit: 2 }]) {
		const { error } = await actions.listRevisions(input);
		assert.equal(error.code, 'revision_invalid_request');
		assert.equal(error.applied, false);
		assert.equal(typeof error.message, 'string');
	}
	assert.equal(calls, 0);
	assert.deepEqual(await actions.listRevisions({ notebook_ids: ['b'.repeat(32)] }), {
		error: { code: 'notebook_unavailable', message: 'The notebook is unavailable.', applied: false },
	});
	assert.equal(calls, 1);
});

test('contextual patch failures use the expected non-applied action envelope', async () => {
	const codes = [
		'note_patch_invalid',
		'note_patch_not_found',
		'note_patch_ambiguous',
		'note_patch_order',
		'note_patch_body_conflict',
	];
	for (const code of codes) {
		const message = `Expected ${code}`;
		const actions = actionsFor(async () => ({}), async () => { throw new JoplinError(message, code); });
		assert.deepEqual(await actions.updateNote({}), {
			error: { code, message, applied: false },
		});
	}
});
