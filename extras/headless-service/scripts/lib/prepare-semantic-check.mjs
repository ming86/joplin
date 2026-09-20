import { ServiceError, requireValue } from '../../src/errors.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Persisted readiness describes the previous scan, not the current collection.
// Run with exclusive ownership and no background scheduler before MCP starts.
export async function prepareSemanticCheck(runtime, waitMs) {
	requireValue(Number.isSafeInteger(waitMs) && waitMs > 0 && waitMs <= 3600000, 'invalid_wait_limit');
	requireValue(typeof runtime.engine?.runOnce === 'function', 'semantic_unavailable');
	const signal = AbortSignal.timeout(waitMs);
	let rescan = true;
	while (!signal.aborted) {
		await runtime.engine.runOnce({ rescan, signal });
		rescan = false;
		if (signal.aborted) break;
		const state = runtime.service.status().semantic;
		if (state.state === 'ready') return state;
		if (state.state === 'unavailable') throw new ServiceError('semantic_unavailable');
		try { await delay(250, undefined, { signal }); } catch { break; }
	}
	throw new ServiceError('index_not_ready_before_deadline');
}
