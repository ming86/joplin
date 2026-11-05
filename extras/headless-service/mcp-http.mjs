#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ServiceError } from './index.mjs';
import { openMcpRuntime } from './src/semantic/runtime.mjs';
import { startMcpHttpServer } from './src/mcp/http.mjs';

/** Run the stateless HTTP transport from one absolute configuration file. */
async function main() {
	let runtime;
	let server;
	let closeServerPromise;
	let stopStarted = false;
	let resolveStopped;
	const stopped = new Promise(resolve => { resolveStopped = resolve; });
	const closeServer = () => closeServerPromise ??= server.close();
	const stop = () => {
		if (stopStarted) return;
		stopStarted = true;
		void closeServer().then(resolveStopped, () => {
			console.error('MCP HTTP shutdown failed');
			process.exitCode = 1;
			resolveStopped();
		});
	};

	try {
		if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) {
			throw new ServiceError('usage_node_mcp_http_mjs_absolute_config_path');
		}
		runtime = await openMcpRuntime(process.argv[2], { transport: 'http' });
		server = await startMcpHttpServer({ service: runtime.service, allowWrites: runtime.allowWrites, allowAttachmentWrites: runtime.allowAttachmentWrites, ...runtime.httpConfig });
		process.once('SIGTERM', stop);
		process.once('SIGINT', stop);
		await stopped;
	} catch (error) {
		// Never print a backend URL, token, note, input JSON or native stack trace.
		console.error(`MCP startup failed: ${error instanceof ServiceError ? error.code : 'configuration_or_transport_error'}`);
		process.exitCode = 1;
	} finally {
		process.removeListener('SIGTERM', stop);
		process.removeListener('SIGINT', stop);
		try {
			if (server && !closeServerPromise) await server.close();
			else if (closeServerPromise) await closeServerPromise;
		} catch {
			// A signal-driven close reports its failure once in stop().
			if (!stopStarted) { console.error('MCP HTTP shutdown failed'); process.exitCode = 1; }
		}
		try { await runtime?.close(); } catch { console.error('MCP semantic shutdown failed'); process.exitCode = 1; }
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
