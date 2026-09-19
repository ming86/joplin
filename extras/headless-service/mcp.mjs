#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ServiceError } from './index.mjs';
import { loadMcpConfig } from './src/mcp/config.mjs';
import { createMcpSession } from './src/mcp/session.mjs';
import { serveStdio } from './src/mcp/stdio.mjs';
export { createMcpSession } from './src/mcp/session.mjs';

async function main() {
	try {
		if (process.argv.length !== 3) throw new ServiceError('usage_node_mcp_mjs_absolute_config_path');
		const { service, allowWrites } = loadMcpConfig(process.argv[2]);
		const transport = serveStdio(createMcpSession(service, { allowWrites }));
		const stop = () => { void transport.close(); };
		process.once('SIGTERM', stop); process.once('SIGINT', stop);
		const result = await transport.done;
		process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
		process.stdin.destroy();
		process.exitCode = result.failed ? 1 : 0;
	} catch (error) {
		// Never print a backend URL, token, note, input JSON or native stack trace.
		console.error(`MCP startup failed: ${error instanceof ServiceError ? error.code : 'configuration_or_transport_error'}`);
		process.exitCode = 1;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
