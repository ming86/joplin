import { Worker } from 'node:worker_threads';
import { ServiceError } from './errors.mjs';
import { logOperationError, withDiagnostics } from './diagnostics.mjs';

/**
 * @typedef {object} RegexJob
 * @property {'any'|'page'} kind Whether to stop at the first match or select page indices.
 * @property {string} body Exact current or revision-snapshot body, copied into the worker.
 * @property {number} [skip] Matching lines to count without returning their indices.
 * @property {number} [take] Maximum returned indices, including the page's lookahead.
 */

/** Cumulative elapsed allowance for one call's regex jobs, including message transfer. */
const regexTimeoutMs = 60_000;

/**
 * Own one lazy worker for a grep call's serial jobs. Backend I/O between jobs
 * does not spend the allowance. The signal also releases an idle worker while
 * the caller waits for its next backend read.
 *
 * @param {{pattern: string, caseSensitive: boolean, signal?: AbortSignal, timeoutMs?: number}} options
 * Pattern and flags have already passed the grep input validation. `timeoutMs`
 * is an internal test seam, not a public tool setting.
 */
export function createRegexMatcher({ pattern, caseSensitive, signal, timeoutMs = regexTimeoutMs }) {
	let worker;
	let pending;
	let failure;
	let closed = false;
	let elapsedMs = 0;
	let termination = Promise.resolve();

	/** Release the thread exactly once and detach the call's abort listener. */
	function stop() {
		if (!closed) {
			closed = true;
			signal?.removeEventListener('abort', onAbort);
			if (worker) termination = worker.terminate();
		}
		return termination;
	}

	/** Attach only sanitized, fixed operation metadata to a worker boundary failure. */
	function boundaryError(code, cause) {
		const error = withDiagnostics(new ServiceError(code, false, code, { cause }), {
			operation: 'grep_notes', stage: 'regex_matching', elapsedMs, timeoutMs,
		});
		logOperationError(error, { operation: 'grep_notes' });
		return error;
	}

	/** Reject active or future jobs and terminate even if V8 is stuck in RegExp.test. */
	function fail(code, cause) {
		if (pending) pending.finish(code, undefined, cause);
		else {
			failure ??= code === 'request_cancelled' ? new ServiceError(code) : boundaryError(code, cause);
			stop();
		}
	}

	/** Preserve the transport's cancellation code without exposing its arbitrary reason. */
	function onAbort() {
		fail('request_cancelled');
	}
	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted) onAbort();

	return {
		/**
		 * Send one body copy and return a bounded result; jobs must be awaited serially.
		 * @param {RegexJob} job One complete note body and its bounded selection.
		 * @returns {Promise<{matched: boolean}|{indices: number[], matchCount: number}>}
		 * `indices` are zero-based source-line indices; `matchCount` includes skipped matches.
		 */
		async match(job) {
			if (failure) throw failure;
			if (closed) throw new ServiceError('request_cancelled');
			const started = performance.now();
			return new Promise((resolve, reject) => {
				/** Settle once, charge job time, and release all per-job closures. */
				const finish = (code, result, cause) => {
					if (!pending) return;
					clearTimeout(timer);
					pending = undefined;
					elapsedMs += performance.now() - started;
					if (!code && elapsedMs >= timeoutMs) code = 'regex_timeout';
					if (code) {
						failure = code === 'request_cancelled' ? new ServiceError(code) : boundaryError(code, cause);
						stop();
						reject(failure);
					} else resolve(result);
				};
				const timer = setTimeout(() => fail('regex_timeout'), Math.max(1, Math.ceil(timeoutMs - elapsedMs)));
				pending = { finish };
				try {
					if (!worker) {
						worker = new Worker(new URL('./grep-matching-worker.mjs', import.meta.url), {
							workerData: { pattern, caseSensitive },
						});
						worker.on('message', result => pending?.finish(undefined, result));
						worker.on('error', cause => fail('regex_worker_failed', cause));
						worker.on('exit', () => {
							if (!closed) fail('regex_worker_failed');
						});
					}
					// Structured clone creates one transient worker-owned body string.
					worker.postMessage(job);
				} catch (cause) {
					fail('regex_worker_failed', cause);
				}
			});
		},
		/** Wait for thread cleanup on normal completion, cancellation, or failure. */
		close: stop,
	};
}
