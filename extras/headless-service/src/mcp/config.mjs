import fs from 'node:fs';
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

// Local process ownership is the stdio identity boundary. clientInfo and tool
// arguments are never accepted as authentication, subjects or account selectors.
export function loadMcpConfig(filename) {
	const input = JSON.parse(readFile(filename, 65536, false));
	check(input && typeof input === 'object' && !Array.isArray(input));
	const allowed = ['accountId', 'baseUrl', 'apiTokenFile', 'allowWrites', 'semanticDatabasePath', 'semanticKeyRef', 'allowInsecureHttp', 'timeoutMs', 'semantic'];
	check(Object.keys(input).every(key => allowed.includes(key)));
	check(input.allowWrites === undefined || typeof input.allowWrites === 'boolean');
	const token = readFile(input.apiTokenFile, 4096, true).trim();
	check(token.length > 0 && !/\s/.test(token), 'invalid_api_token');
	const config = {
		id: input.accountId, subjects: ['local-stdio'], permissions: input.allowWrites ? ['read', 'write'] : ['read'],
		joplin: { baseUrl: input.baseUrl, token, allowInsecureHttp: input.allowInsecureHttp, timeoutMs: input.timeoutMs },
		// Reserved names only: Phase 2A neither opens this DB nor obtains its key.
		semantic: { databasePath: input.semanticDatabasePath ?? path.join(path.dirname(filename), `${input.accountId}.semantic.sqlite`), keyRef: input.semanticKeyRef ?? `${input.accountId}/semantic` },
	};
	if (input.semantic?.enabled === true) config.embedding = input.semantic.embedding;
	const registry = createAccountRegistry([config]);
	return { service: registry.forPrincipal('local-stdio', input.accountId), allowWrites: input.allowWrites === true, accountConfig: config, semanticConfig: input.semantic };
}
