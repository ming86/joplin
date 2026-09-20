import { readFile } from '../mcp/config.mjs';
import { identifier, requireValue } from '../errors.mjs';
import { webOrigin } from './http.mjs';

export function loadWebConfig(filename) {
	const c = JSON.parse(readFile(filename, 65536, false));
	requireValue(c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).every(k => ['accountConfigFile', 'webTokenFile', 'namespace', 'port', 'publicOrigin', 'markdownModule', 'stdio', 'sessionMs'].includes(k)), 'invalid_web_configuration');
	identifier(c.namespace);
	requireValue(Number.isSafeInteger(c.port) && c.port > 0 && c.port <= 65535, 'invalid_web_port');
	webOrigin(c.publicOrigin);
	requireValue(c.stdio === undefined || typeof c.stdio === 'boolean', 'invalid_stdio_option');
	const token = readFile(c.webTokenFile, 4096, true).trim();
	requireValue(/^[A-Za-z0-9_-]{32,256}$/.test(token), 'invalid_web_token');
	return { ...c, token };
}
