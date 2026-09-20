#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadWebConfig } from './src/web/config.mjs';
import { openMcpRuntime } from './src/semantic/runtime.mjs';
import { createWebService } from './src/web/service.mjs';
import { createMarkdownRenderer } from './src/web/render.mjs';
import { startWebServer } from './src/web/http.mjs';
import { ServiceError, requireValue } from './src/errors.mjs';
import { createMcpSession } from './src/mcp/session.mjs';
import { serveStdio } from './src/mcp/stdio.mjs';

async function main() {
	let runtime, web, transport;
	try {
		requireValue(process.argv.length === 3, 'usage_node_web_mjs_absolute_config');
		const config = loadWebConfig(process.argv[2]);
		const render = createMarkdownRenderer(config.markdownModule);
		runtime = await openMcpRuntime(config.accountConfigFile);
		requireValue(config.token !== runtime.accountConfig.joplin.token, 'separate_web_token_required');
		const service = createWebService({ account: runtime.service, namespace: config.namespace, allowWrites: runtime.allowWrites, render });
		web = await startWebServer({ service, ...config });
		// One process owns one semantic store. Optional stdio MCP shares that same
		// runtime rather than starting a second owner of the encrypted index.
		let resolveStop;
		const stopped = new Promise(resolve => { resolveStop = resolve; });
		const stop = () => resolveStop();
		process.once('SIGTERM', stop); process.once('SIGINT', stop);
		if (config.stdio) {
			transport = serveStdio(createMcpSession(runtime.service, { allowWrites: runtime.allowWrites }));
			transport.done.then(result => { if (result.failed) process.exitCode = 1; resolveStop(); });
		}
		console.error('web: ready (loopback listener; synchronization not observed)');
		await stopped;
		process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
	} catch (error) {
		console.error(`Web service failed: ${error instanceof ServiceError ? error.code : 'configuration_or_runtime_error'}`);
		process.exitCode = 1;
	} finally {
		for (const component of [web, transport, runtime]) {
			try { await component?.close(); }
			catch { console.error('Web service shutdown failed'); process.exitCode = 1; }
		}
		if (transport) process.stdin.destroy();
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
