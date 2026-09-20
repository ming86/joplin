#!/usr/bin/env node
import { loadClipConfig } from './src/clipper/config.mjs';
import { startClipServer } from './src/clipper/http.mjs';
import { ServiceError } from './src/errors.mjs';
let server;
try {
	if (process.argv.length !== 3) throw new ServiceError('usage_node_clipper_mjs_absolute_config');
	server = await startClipServer(loadClipConfig(process.argv[2]));
	console.log(`clipper: ready on 127.0.0.1:${server.port}`);
	const stop = async () => { await server.close(); };
	process.once('SIGTERM', stop); process.once('SIGINT', stop);
} catch (error) {
	console.error(error instanceof ServiceError ? error.code : 'clipper_startup_failed');
	process.exitCode = 1; await server?.close();
}
