import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createAccountRegistry, ServiceError } from '../../index.mjs';

function check(condition, code = 'invalid_mcp_configuration') { if (!condition) throw new ServiceError(code); }
export function readFile(filename, maxBytes, privateMode) {
	check(typeof filename === 'string' && path.isAbsolute(filename), 'absolute_path_required');
	const fd = fs.openSync(filename, 'r');
	try {
		const stat = fs.fstatSync(fd);
		check(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'invalid_configuration_file');
		if (privateMode) check((stat.mode & 0o077) === 0, 'private_token_permissions_required');
		const data = Buffer.alloc(maxBytes + 1);
		const size = fs.readSync(fd, data, 0, data.length, 0);
		check(size <= maxBytes, 'invalid_configuration_file');
		return data.subarray(0, size).toString('utf8');
	} finally { fs.closeSync(fd); }
}

/** Validate a configured host name or IP address without accepting a URL. */
function isListenHost(value) {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
	if (net.isIP(value)) return true;
	if (value.length > 253 || /[/:?#@\\\s]/.test(value)) return false;
	const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
	return hostname.length > 0 && hostname.split('.').every(label =>
		label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
	);
}

/** Validate that a string is a canonical HTTP(S) origin with no extra URL parts. */
function isAllowedOrigin(value) {
	if (typeof value !== 'string') return false;
	try {
		const parsed = new URL(value);
		return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === value;
	} catch {
		return false;
	}
}

/** HTTP listener settings returned when the HTTP transport is selected.
 * @typedef {object} McpHttpConfig
 * @property {string} listenHost Listener hostname or IP address.
 * @property {number} listenPort Listener port from 1 through 65535.
 * @property {string} bearerToken Private bearer token bound to the configured operator account.
 * @property {string[]} allowedOrigins Exact HTTP(S) origins permitted by the listener.
 */

// Both transports expose the one configured operator account. Stdio uses the
// local process identity; HTTP uses its configured bearer token. Neither accepts
// clientInfo or tool arguments as authentication, subjects or account selectors.
/**
 * Load the configured account service and optional transport settings.
 * @param {string} filename Absolute path to the JSON configuration file.
 * @param {{transport?: 'stdio'|'http'}} [options] Selects stdio or HTTP transport.
 * @returns {{service: object, allowWrites: boolean, allowAttachmentWrites: boolean, accountConfig: object, semanticConfig: (object|undefined), httpConfig?: McpHttpConfig}} `allowAttachmentWrites` defaults to true and reads only the exact `true` or `false` environment values.
 */
export function loadMcpConfig(filename, { transport = 'stdio' } = {}) {
	check(transport === 'stdio' || transport === 'http');
	const attachmentWriteSetting = process.env.JOPLIN_MCP_ALLOW_ATTACHMENT_WRITES;
	check(attachmentWriteSetting === undefined || attachmentWriteSetting === 'true' || attachmentWriteSetting === 'false');
	const allowAttachmentWrites = attachmentWriteSetting !== 'false';
	const input = JSON.parse(readFile(filename, 65536, false));
	check(input && typeof input === 'object' && !Array.isArray(input));
	const allowed = ['accountId', 'baseUrl', 'apiTokenFile', 'allowWrites', 'defaultNotebookId', 'semanticDatabasePath', 'semanticKeyRef', 'allowInsecureHttp', 'timeoutMs', 'semantic', 'listenHost', 'listenPort', 'bearerTokenFile', 'allowedOrigins'];
	check(Object.keys(input).every(key => allowed.includes(key)));
	check(input.allowWrites === undefined || typeof input.allowWrites === 'boolean');
	check(input.defaultNotebookId === undefined || (typeof input.defaultNotebookId === 'string' && /^[a-f0-9]{32}$/.test(input.defaultNotebookId)));
	check(input.listenHost === undefined || isListenHost(input.listenHost));
	check(input.listenPort === undefined || (Number.isInteger(input.listenPort) && input.listenPort >= 1 && input.listenPort <= 65535));
	check(input.bearerTokenFile === undefined || (typeof input.bearerTokenFile === 'string' && path.isAbsolute(input.bearerTokenFile)));
	check(input.allowedOrigins === undefined || (Array.isArray(input.allowedOrigins) && input.allowedOrigins.every(isAllowedOrigin)));
	const token = readFile(input.apiTokenFile, 4096, true).trim();
	check(token.length > 0 && !/\s/.test(token), 'invalid_api_token');
	let httpConfig;
	if (transport === 'http') {
		const bearerToken = readFile(input.bearerTokenFile, 4096, true).trim();
		check(bearerToken.length > 0 && !/\s/.test(bearerToken), 'invalid_bearer_token');
		httpConfig = {
			listenHost: input.listenHost ?? '127.0.0.1',
			listenPort: input.listenPort ?? 41191,
			bearerToken,
			allowedOrigins: input.allowedOrigins ?? [],
		};
	}
	const config = {
		id: input.accountId, subjects: ['local-stdio'], permissions: input.allowWrites ? ['read', 'write'] : ['read'],
		joplin: { baseUrl: input.baseUrl, token, allowInsecureHttp: input.allowInsecureHttp, timeoutMs: input.timeoutMs },
		...(input.defaultNotebookId ? { defaultNotebookId: input.defaultNotebookId } : {}),
		// Reserved names only: Phase 2A neither opens this DB nor obtains its key.
		semantic: { databasePath: input.semanticDatabasePath ?? path.join(path.dirname(filename), `${input.accountId}.semantic.sqlite`), keyRef: input.semanticKeyRef ?? `${input.accountId}/semantic` },
	};
	if (input.semantic?.enabled === true) config.embedding = input.semantic.embedding;
	const registry = createAccountRegistry([config]);
	return {
		service: registry.forPrincipal('local-stdio', input.accountId),
		allowWrites: input.allowWrites === true,
		allowAttachmentWrites,
		accountConfig: config,
		semanticConfig: input.semantic,
		...(httpConfig ? { httpConfig } : {}),
	};
}
