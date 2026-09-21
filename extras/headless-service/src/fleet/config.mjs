import path from 'node:path';
import { createHash } from 'node:crypto';
import { identifier, requireValue } from '../errors.mjs';
import { webOrigin } from '../web/http.mjs';
import { absolute, canonical, overlaps, object, privateJson, privateText, socketPath } from './files.mjs';
const accountId = id => requireValue(typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id), 'invalid_account_id');
const portNumber = port => { requireValue(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'invalid_account_port'); return port; };
const tokenFile = (file, kind) => ({ path: absolute(file), kind });

// Trusted operator configuration only. No request can supply a worker path, key,
// account selector or downstream URL. Read no DB and obtain no unlock key here.
export function loadAccountDefinition(filename) {
	filename = absolute(filename);
	const c = object(privateJson(filename), ['id', 'accountConfigFile', 'core', 'web', 'clipper', 'mcp', 'startupTimeoutMs']); accountId(c.id);
	const core = object(c.core, ['cliPath', 'profilePath', 'databaseKeyFile', 'sqliteModule']);
	for (const k of ['cliPath', 'profilePath', 'databaseKeyFile', 'sqliteModule']) absolute(core[k]);
	const profile = canonical(core.profilePath); requireValue(profile !== path.parse(profile).root, 'invalid_profile_path');
	const ac = object(privateJson(c.accountConfigFile), ['accountId', 'baseUrl', 'apiTokenFile', 'allowWrites', 'semanticDatabasePath', 'semanticKeyRef', 'allowInsecureHttp', 'timeoutMs', 'semantic']);
	requireValue(ac.accountId === c.id, 'account_binding_mismatch');
	const u = new URL(ac.baseUrl);
	requireValue(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password, 'private_core_endpoint_required');
	const ports = [portNumber(Number(u.port))];
	const secrets = [tokenFile(core.databaseKeyFile, 'key'), tokenFile(ac.apiTokenFile, 'token')];
	const semanticPath = canonical(ac.semanticDatabasePath ?? path.join(path.dirname(c.accountConfigFile), `${c.id}.semantic.sqlite`));
	requireValue(!overlaps(profile, semanticPath), 'semantic_store_outside_profile_required');
	if (ac.semantic?.enabled) {
		secrets.push(tokenFile(ac.semantic.keyFile, 'key'));
		requireValue(ac.semantic.rebuild !== true, 'fleet_automatic_rebuild_forbidden');
	}
	if (c.web) {
		object(c.web, ['webTokenFile', 'namespace', 'port', 'publicOrigin', 'markdownModule', 'sessionMs']); identifier(c.web.namespace);
		ports.push(portNumber(c.web.port)); webOrigin(c.web.publicOrigin);
		if (c.web.markdownModule) absolute(c.web.markdownModule);
		secrets.push(tokenFile(c.web.webTokenFile, 'token'));
	}
	if (c.clipper) {
		object(c.clipper, ['clipTokenFile', 'namespace', 'notebookIds', 'port', 'allowedOrigins', 'publicOrigin']); identifier(c.clipper.namespace);
		requireValue(ac.allowWrites === true, 'clipper_requires_write_account');
		requireValue(Array.isArray(c.clipper.notebookIds) && c.clipper.notebookIds.length > 0, 'clip_notebooks_required'); c.clipper.notebookIds.forEach(identifier);
		ports.push(portNumber(c.clipper.port)); secrets.push(tokenFile(c.clipper.clipTokenFile, 'token'));
	}
	if (c.mcp) { object(c.mcp, ['socketPath', 'tokenFile']); socketPath(c.mcp.socketPath); secrets.push(tokenFile(c.mcp.tokenFile, 'token')); }
	requireValue(c.web || c.clipper || c.mcp, 'account_interface_required');
	requireValue(Number.isSafeInteger(c.startupTimeoutMs ?? 120000) && (c.startupTimeoutMs ?? 120000) >= 1000 && (c.startupTimeoutMs ?? 120000) <= 600000, 'invalid_startup_timeout');
	requireValue(new Set(ports).size === ports.length, 'duplicate_account_port');
	for (const secret of secrets) requireValue(!overlaps(profile, canonical(secret.path)), 'secret_outside_profile_required');
	return { ...c, filename, core, account: ac, ports, secrets, profile, semanticPath };
}
export function loadFleetConfig(filename) {
	requireValue(process.platform === 'linux', 'fleet_linux_required');
	const c = object(privateJson(filename), ['runtimeDir', 'stateDir', 'accounts', 'restartLimit']);
	absolute(c.runtimeDir); absolute(c.stateDir); socketPath(path.join(c.runtimeDir, 'control.sock'));
	requireValue(Array.isArray(c.accounts) && c.accounts.length > 0 && c.accounts.length <= 32, 'invalid_account_count');
	requireValue(Number.isSafeInteger(c.restartLimit ?? 3) && (c.restartLimit ?? 3) >= 0 && (c.restartLimit ?? 3) <= 10, 'invalid_restart_limit');
	const accounts = c.accounts.map(loadAccountDefinition);
	const usedIds = new Set(), usedPorts = new Set(), usedPaths = new Set(), origins = new Set(), namespaces = new Set(), keyRefs = new Set();
	for (const a of accounts) {
		requireValue(!usedIds.has(a.id), 'duplicate_account_binding'); usedIds.add(a.id);
		for (const p of a.ports) { requireValue(!usedPorts.has(p), 'duplicate_account_port'); usedPorts.add(p); }
		for (const p of [a.semanticPath, ...a.secrets.map(s => canonical(s.path)), ...(a.mcp ? [canonical(a.mcp.socketPath)] : [])]) {
			requireValue(!usedPaths.has(p), 'duplicate_account_path'); usedPaths.add(p);
		}
		if (a.web) { const origin = webOrigin(a.web.publicOrigin).origin; requireValue(!origins.has(origin), 'duplicate_web_origin'); origins.add(origin); }
		for (const n of [a.web?.namespace, a.clipper?.namespace].filter(Boolean)) { requireValue(!namespaces.has(n), 'duplicate_account_namespace'); namespaces.add(n); }
		const ref = a.account.semanticKeyRef ?? `${a.id}/semantic`; requireValue(!keyRefs.has(ref), 'duplicate_account_key_reference'); keyRefs.add(ref);
		for (const other of accounts) {
			if (other === a) continue;
			requireValue(!overlaps(a.profile, other.profile) && !overlaps(a.profile, other.semanticPath), 'overlapping_account_storage');
		}
		for (const control of [canonical(c.runtimeDir), canonical(c.stateDir)]) requireValue(!overlaps(a.profile, control) && !overlaps(a.semanticPath, control), 'control_storage_overlap');
	}
	return { ...c, accounts };
}
// Missing/unreadable unlock material affects that account, not every account.
// Check all presently readable credentials and active generations on every start.
export function secretHashes(account) {
	return account.secrets.map(s => {
		let text = privateText(s.path, 4096).trim();
		requireValue(s.kind === 'key' ? /^[a-fA-F0-9]{64}$/.test(text) : /^[A-Za-z0-9_-]{32,256}$/.test(text), 'invalid_account_secret');
		if (s.kind === 'key') text = text.toLowerCase();
		return createHash('sha256').update(text).digest('hex');
	});
}
export function checkSecrets(candidate, accounts, active = new Map()) {
	const own = secretHashes(candidate); requireValue(new Set(own).size === own.length, 'reused_account_secret');
	for (const other of accounts) {
		if (other.id === candidate.id) continue;
		let configured = []; try { configured = secretHashes(other); } catch {}
		const occupied = new Set([...(active.get(other.id) ?? []), ...configured]);
		requireValue(!own.some(h => occupied.has(h)), 'reused_account_secret');
	}
	return own;
}
