import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSemanticCheck } from '../scripts/lib/prepare-semantic-check.mjs';

test('relevance checker reconciles even a persisted ready index and drains new jobs', async () => {
	const calls = []; let state = { state: 'ready', indexedNotes: 25 };
	const runtime = {
		engine: { status: () => state, async runOnce({ rescan }) {
			calls.push(rescan);
			state = calls.length === 1 ? { state: 'indexing', pendingNotes: 4 } : { state: 'ready', indexedNotes: 29 };
		} },
	};
	assert.equal((await prepareSemanticCheck(runtime, 3000)).indexedNotes, 29);
	assert.deepEqual(calls, [true, false]);
});
test('relevance preparation fails closed for unavailable engine and timed-out work', async () => {
	await assert.rejects(prepareSemanticCheck({}, 50), { code: 'semantic_unavailable' });
	await assert.rejects(prepareSemanticCheck({ engine: { status: () => ({ state: 'degraded' }), runOnce: async () => {} } }, 20), { code: 'index_not_ready_before_deadline' });
});
