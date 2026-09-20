import { readFile } from '../mcp/config.mjs';
import { createJoplinClient } from '../joplin.mjs';
import { requireValue } from '../errors.mjs';
import { createClipService } from './service.mjs';

export function loadClipConfig(filename) {
	const c = JSON.parse(readFile(filename, 65536, false));
	requireValue(c && typeof c === 'object' && !Array.isArray(c));
	requireValue(Object.keys(c).every(k => ['accountId','baseUrl','apiTokenFile','clipTokenFile','namespace','notebookIds','port','allowedOrigins','publicOrigin','timeoutMs'].includes(k)), 'invalid_clipper_configuration');
	const apiToken = readFile(c.apiTokenFile, 4096, true).trim();
	const token = readFile(c.clipTokenFile, 4096, true).trim();
	requireValue(/^[A-Za-z0-9_-]{32,256}$/.test(token) && token !== apiToken, 'separate_clip_token_required');
	requireValue(Number.isSafeInteger(c.port) && c.port > 0 && c.port <= 65535, 'invalid_clipper_port');
	const backend = createJoplinClient({ baseUrl: c.baseUrl, token: apiToken, timeoutMs: c.timeoutMs });
	return { service: createClipService({ accountId: c.accountId, namespace: c.namespace, notebookIds: c.notebookIds, backend }), token, port: c.port, allowedOrigins: c.allowedOrigins ?? [], publicOrigin: c.publicOrigin };
}
