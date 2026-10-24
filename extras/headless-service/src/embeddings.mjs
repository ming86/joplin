import { createHash } from 'node:crypto';
import { requireValue, ServiceError } from './errors.mjs';
import { withDiagnostics } from './diagnostics.mjs';

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

/**
 * Binds model-specific text preparation and vector validation around a transport.
 * Transport failures keep their cause and safe adapter diagnostics under stable public codes.
 * @param {object} input Embedding-space definition for this account.
 * @param {(texts: string[], purpose: 'document'|'query', signal?: AbortSignal) => Promise<object>} transport Provider transport.
 * @returns {object} Frozen provider with its normalized embedding space and embed operation.
 */
export function bindEmbeddingProvider(input, transport) {
	const space = embeddingSpace(input);
	return Object.freeze({
		space,
		async embed(texts, purpose, signal) {
			requireValue(purpose === 'document' || purpose === 'query', 'invalid_embedding_purpose');
			requireValue(Array.isArray(texts) && texts.length > 0 && texts.every(text => typeof text === 'string' && text.length > 0), 'invalid_embedding_input');
			if (signal?.aborted) throw new ServiceError('request_cancelled', false, 'request_cancelled', { cause: signal.reason });
			if (!transport) throw new ServiceError('embedding_provider_unavailable');
			const prefix = purpose === 'query' ? space.queryPrefix : space.documentPrefix;
			let response;
			try { response = await transport(texts.map(text => prefix + text), purpose, signal); }
			catch (error) {
				// Preserve the public cancellation/unavailable code and keep the transport error private as its cause.
				if (signal?.aborted) {
					const cancelled = new ServiceError('request_cancelled', false, 'request_cancelled', { cause: error });
					if (error instanceof Error && error.diagnostics) withDiagnostics(cancelled, error.diagnostics);
					throw cancelled;
				}
				if (error instanceof ServiceError) throw error;
				const unavailable = new ServiceError('embedding_provider_unavailable', false, 'embedding_provider_unavailable', { cause: error });
				if (error instanceof Error && error.diagnostics) withDiagnostics(unavailable, error.diagnostics);
				throw unavailable;
			}
			if (signal?.aborted) throw new ServiceError('request_cancelled', false, 'request_cancelled', { cause: signal.reason });
			try {
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
			} catch (error) {
				// No HTTP status or request timing is available after the transport returns parsed JSON.
				if (error instanceof ServiceError && error.code === 'invalid_embedding_response') {
					throw withDiagnostics(error, { stage: 'validate_embedding_response' });
				}
				throw error;
			}
		},
	});
}
