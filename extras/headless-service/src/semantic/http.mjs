import { endpoint } from '../joplin.mjs';
import { requireValue, ServiceError } from '../errors.mjs';

// No client-side body truncation, redirects, vendor SDK, or cross-model fallback.
// Provider tokenizer/truncation behavior still needs a live endpoint check. The
// indexer owns resumable retries; interactive requests make one bounded attempt.
export function createEmbeddingTransport(config, fetchImpl = fetch) {
	const base = endpoint(config.baseUrl, config.allowInsecureHttp);
	const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname);
	requireValue(typeof config.remoteProcessing === 'boolean' && (local || config.remoteProcessing), 'remote_processing_not_allowed');
	requireValue(typeof config.model === 'string' && config.model.length > 0);
	const timeoutMs = config.timeoutMs ?? 30000;
	const maxBatch = config.maxBatch ?? 16;
	for (const [n, maximum] of [[timeoutMs, 120000], [maxBatch, 128]]) requireValue(Number.isSafeInteger(n) && n > 0 && n <= maximum);
	requireValue(config.apiKey === undefined || (typeof config.apiKey === 'string' && config.apiKey.length > 0 && !/[\r\n]/.test(config.apiKey)));
	return async (input, _purpose, signal) => {
		requireValue(Array.isArray(input) && input.length > 0 && input.length <= maxBatch, 'embedding_batch_too_large');
		requireValue(input.every(text => typeof text === 'string' && text.length > 0));
		if (signal?.aborted) throw new ServiceError('request_cancelled');
		const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
		try {
			const response = await fetchImpl(new URL('embeddings', base), {
				method: 'POST', redirect: 'error', signal: combined,
				headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
				body: JSON.stringify({ model: config.model, input, encoding_format: 'float' }),
			});
			if (!response.ok) {
				await response.body?.cancel();
				const error = new ServiceError(response.status === 429 ? 'embedding_rate_limited' : response.status === 401 || response.status === 403 ? 'embedding_authorization_failed' : 'embedding_provider_unavailable');
				const retry = response.headers.get('retry-after');
				const delay = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
				if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.min(delay, 24 * 3600000);
				throw error;
			}
			const parts = [];
			if (response.body) {
				const reader = response.body.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read(); if (done) break;
						parts.push(Buffer.from(value));
					}
				} finally { reader.releaseLock(); }
			}
			return JSON.parse(Buffer.concat(parts).toString('utf8'));
		} catch (error) {
			if (signal?.aborted) throw new ServiceError('request_cancelled');
			if (error instanceof ServiceError) throw error;
			throw new ServiceError('embedding_provider_unavailable');
		}
	};
}
