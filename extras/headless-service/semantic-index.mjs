#!/usr/bin/env node
import { openMcpRuntime } from './src/semantic/runtime.mjs';
import { ServiceError } from './src/errors.mjs';

let runtime;
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
try {
	if (process.argv.length !== 3) throw new ServiceError('usage_node_semantic_index_mjs_absolute_mcp_config');
	runtime = await openMcpRuntime(process.argv[2], { background: false });
	if (!runtime.engine?.runOnce) throw new ServiceError(runtime.engine?.status?.().reason ?? 'semantic_not_configured');
	// One bounded indexing cycle. Re-run to continue large backlogs; the cursor,
	// pending IDs and retry deadlines are persisted. Do not run alongside MCP's
	// semantic owner for this same database.
	await runtime.engine.runOnce({ signal: controller.signal });
	const status = { accountId: runtime.accountConfig.id, semantic: runtime.engine.status() };
	console.log(JSON.stringify(status));
	process.exitCode = controller.signal.aborted ? 130 : status.semantic.state === 'ready' ? 0 : 2;
} catch (error) {
	console.error(error instanceof ServiceError ? error.code : 'semantic_index_failed'); process.exitCode = 1;
} finally { await runtime?.close(); }
