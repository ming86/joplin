import { createHash } from 'node:crypto';
import { requireValue, ServiceError } from './errors.mjs';

export function embeddingSpace(input) {
	requireValue(input && typeof input === 'object');
	for (const name of ['id', 'revision', 'preprocessingVersion']) requireValue(typeof input[name] === 'string' && input[name].length > 0);
	requireValue(Number.isSafeInteger(input.dimensions) && input.dimensions > 0 && input.dimensions <= 65536);
	const output = {
		id: input.id, revision: input.revision, dimensions: input.dimensions,
		preprocessingVersion: input.preprocessingVersion,
		normalization: input.normalization ?? 'l2',
		documentPrefix: input.documentPrefix ?? '', queryPrefix: input.queryPrefix ?? '',
	};
	requireValue(['l2', 'none'].includes(output.normalization));
	requireValue(typeof output.documentPrefix === 'string' && typeof output.queryPrefix === 'string');
	return Object.freeze(output);
}

export function embeddingFingerprint(input) {
	return createHash('sha256').update(JSON.stringify(embeddingSpace(input))).digest('hex');
}

export function noteFingerprint(note, preprocessingVersion) {
	requireValue(typeof note.title === 'string' && typeof note.body === 'string' && typeof preprocessingVersion === 'string', 'invalid_note_input');
	return createHash('sha256').update(JSON.stringify([note.title, note.body, preprocessingVersion])).digest('hex');
}

// The transport is supplied by the trusted application; HTTP and fake transports
// share validation and model-specific preparation here.
export function bindEmbeddingProvider(input, transport) {
	const space = embeddingSpace(input);
	return Object.freeze({
		space,
		async embed(texts, purpose, signal) {
			requireValue(purpose === 'document' || purpose === 'query', 'invalid_embedding_purpose');
			requireValue(Array.isArray(texts) && texts.length > 0 && texts.every(text => typeof text === 'string' && text.length > 0), 'invalid_embedding_input');
			if (signal?.aborted) throw new ServiceError('request_cancelled');
			if (!transport) throw new ServiceError('embedding_provider_unavailable');
			const prefix = purpose === 'query' ? space.queryPrefix : space.documentPrefix;
			let response;
			try { response = await transport(texts.map(text => prefix + text), purpose, signal); }
			catch (error) {
				if (signal?.aborted) throw new ServiceError('request_cancelled');
				if (error instanceof ServiceError) throw error;
				throw new ServiceError('embedding_provider_unavailable');
			}
			if (signal?.aborted) throw new ServiceError('request_cancelled');
			requireValue(response && Array.isArray(response.data) && response.data.length === texts.length, 'invalid_embedding_response');
			const vectors = new Array(texts.length);
			for (const item of response.data) {
				requireValue(item && Number.isSafeInteger(item.index) && item.index >= 0 && item.index < texts.length && !vectors[item.index], 'invalid_embedding_response');
				requireValue(Array.isArray(item.embedding) && item.embedding.length === space.dimensions && item.embedding.every(value => typeof value === 'number' && Number.isFinite(value)), 'invalid_embedding_response');
				const vector = item.embedding.slice();
				const norm = Math.hypot(...vector);
				requireValue(norm > 0 && Number.isFinite(norm), 'invalid_embedding_response');
				vectors[item.index] = space.normalization === 'l2' ? vector.map(value => value / norm) : vector;
			}
			const inputTokens = response.usage?.prompt_tokens;
			requireValue(inputTokens === undefined || (Number.isSafeInteger(inputTokens) && inputTokens >= 0), 'invalid_embedding_response');
			return { vectors, embeddingSpaceId: space.id, spaceFingerprint: embeddingFingerprint(space), ...(inputTokens === undefined ? {} : { inputTokens }) };
		},
	});
}
