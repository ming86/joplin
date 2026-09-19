import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindEmbeddingProvider, embeddingFingerprint, noteFingerprint } from '../index.mjs';
import { space } from './fixtures.mjs';
const code = expected => error => error.code === expected;

test('document/query preparation is applied once; response index restores input order', async () => {
	const calls = [];
	const provider = bindEmbeddingProvider({ ...space, queryPrefix: 'Query: ' }, async (texts, purpose) => {
		calls.push([texts, purpose]); return { data: [{ index: 1, embedding: [0, 4] }, { index: 0, embedding: [3, 0] }], usage: { prompt_tokens: 12 } };
	});
	const output = await provider.embed(['one', 'two'], 'query');
	assert.deepEqual(output.vectors, [[1, 0], [0, 1]]); assert.equal(output.inputTokens, 12);
	assert.deepEqual(calls[0], [['Query: one', 'Query: two'], 'query']);
	await provider.embed(['one', 'two'], 'document'); assert.deepEqual(calls[1], [['one', 'two'], 'document']);
});

test('duplicate, missing, invalid, nonfinite, wrong-dimension and zero vectors are rejected', async () => {
	const cases = [
		{ data: [] }, { data: [{ index: 1, embedding: [1, 0] }] },
		{ data: [{ index: 0, embedding: [1] }] }, { data: [{ index: 0, embedding: [Infinity, 0] }] },
		{ data: [{ index: 0, embedding: [0, 0] }] }, { data: [{ index: 0, embedding: ['1', 0] }] },
		{ data: [{ index: 0, embedding: [NaN, 0] }] },
	];
	for (const value of cases) await assert.rejects(bindEmbeddingProvider(space, async () => value).embed(['one'], 'document'), code('invalid_embedding_response'));
	const duplicate = { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }] };
	await assert.rejects(bindEmbeddingProvider(space, async () => duplicate).embed(['one', 'two'], 'query'), code('invalid_embedding_response'));
});

test('explicit unavailable errors, input checks, cancellation and safe provider errors', async () => {
	const provider = bindEmbeddingProvider(space, async () => { throw new Error('secret-token / note-body'); });
	await assert.rejects(provider.embed(['one'], 'query'), error => error.code === 'embedding_provider_unavailable' && !JSON.stringify(error).includes('secret'));
	await assert.rejects(provider.embed([], 'query'), code('invalid_embedding_input'));
	await assert.rejects(provider.embed(['one'], 'other'), code('invalid_embedding_purpose'));
	await assert.rejects(provider.embed(['one'], 'query', AbortSignal.abort()), code('request_cancelled'));
});

test('index fingerprint changes with representation, but not unrelated deployment settings', () => {
	const a = embeddingFingerprint(space);
	assert.equal(a, embeddingFingerprint({ ...space, apiKey: 'changed', baseUrl: 'other' }));
	for (const change of [{ dimensions: 4 }, { revision: 'other' }, { queryPrefix: 'Q: ' }, { normalization: 'none' }, { preprocessingVersion: 'v2' }]) {
		assert.notEqual(a, embeddingFingerprint({ ...space, ...change }));
	}
	assert.equal(noteFingerprint({ title: 'A', body: 'B', ignored: true }, 'v1'), noteFingerprint({ title: 'A', body: 'B' }, 'v1'));
	assert.notEqual(noteFingerprint({ title: 'A', body: 'B' }, 'v1'), noteFingerprint({ title: 'A', body: 'C' }, 'v1'));
});
