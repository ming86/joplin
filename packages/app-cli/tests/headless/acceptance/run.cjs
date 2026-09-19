#!/usr/bin/env node
// Opt-in, real-runtime acceptance. Both compiled CLIs and SQLCipher must be available.
// All account/profile/key inputs are private local files; only step names are reported.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { GateError, check, until, launch, normalizedServerUrl, faultProxy, inventory, copyStoppedProfile } = require('./helpers.cjs');

function readConfiguration(filename) {
	check(filename && path.isAbsolute(filename), 'absolute-config-path-required');
	check((fs.statSync(filename).mode & 0o077) === 0, 'config-must-be-private');
	const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
	check(config.allowTestAccountWrites === true && config.sourcesStopped === true, 'test-account-and-stopped-sources-confirmation-required');
	for (const name of ['headlessCli', 'stockCli', 'headlessProfile', 'stockProfile', 'databaseKeyFile', 'sqliteModule', 'workDir']) {
		check(typeof config[name] === 'string' && path.isAbsolute(config[name]), 'absolute-input-paths-required');
	}
	for (const name of ['headlessCli', 'stockCli', 'headlessProfile', 'stockProfile', 'databaseKeyFile', 'sqliteModule']) {
		config[name] = fs.realpathSync(config[name]);
	}
	check(config.headlessCli !== config.stockCli, 'distinct-stock-build-required');
	check(!fs.existsSync(config.workDir), 'work-directory-must-be-new');
	config.workDir = path.join(fs.realpathSync(path.dirname(config.workDir)), path.basename(config.workDir));
	const within = (file, directory) => file === directory || file.startsWith(`${directory}${path.sep}`);
	check(!within(config.headlessProfile, config.stockProfile) && !within(config.stockProfile, config.headlessProfile), 'independent-source-profiles-required');
	for (const source of [config.headlessProfile, config.stockProfile]) {
		check(!within(config.workDir, source) && !within(config.databaseKeyFile, source), 'work-and-key-must-be-outside-source-profiles');
	}
	check((fs.statSync(config.databaseKeyFile).mode & 0o077) === 0, 'key-file-must-be-private');
	check(/^[a-fA-F0-9]{64}(?:\r?\n)?$/.test(fs.readFileSync(config.databaseKeyFile, 'utf8')), 'invalid-key-file-format');
	config.serverUrl = normalizedServerUrl(config.expectedServerUrl);
	check(typeof config.expectedUsername === 'string' && config.expectedUsername.length > 0, 'expected-test-username-required');
	config.timeoutMs = config.timeoutMs ?? 900000;
	check(Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 360000 && config.timeoutMs <= 3600000, 'invalid-stage-timeout');
	return config;
}

function validateProfileSettings(settings, config) {
	check(settings['sync.target'] === 9, 'only-existing-joplin-server-profiles-supported');
	check(normalizedServerUrl(settings['sync.9.path']) === config.serverUrl, 'unexpected-sync-server');
	check(settings['sync.9.username'] === config.expectedUsername, 'unexpected-test-account');
	const info = JSON.parse(settings.syncInfoCache);
	check(info.e2ee?.value === true && info.activeMasterKeyId?.value, 'existing-e2ee-configuration-required');
	return info.activeMasterKeyId.value;
}

async function unusedPort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function acceptance(config, record, signal = new AbortController().signal) {
	const requireFromCli = createRequire(config.headlessCli);
	const locker = requireFromCli('proper-lockfile');
	let leaseLost = false;
	const release = await locker.lock(config.headlessProfile, {
		retries: 0, stale: 30000, update: 10000, onCompromised: () => { leaseLost = true; },
	});
	let daemon;
	let proxy;
	let originals;
	const processes = new Set();
	const onAbort = () => {
		if (proxy) proxy.setOffline(true);
		for (const child of processes) void child.stop();
	};
	signal.addEventListener('abort', onAbort);
	let stage = 'copy-stopped-profiles';
	const headlessDir = path.join(config.workDir, 'headless');
	const stockDir = path.join(config.workDir, 'stock');
	let apiToken;
	let apiPort;
	const native = { sqliteModule: config.sqliteModule, keyFile: config.databaseKeyFile };
	const headlessCommand = async (args, input, directory = headlessDir) => {
		check(!daemon || daemon.closed, 'headless-one-shot-command-while-serving');
		return trackedRun(config.headlessCli, directory, args, { ...native, input, timeoutMs: config.timeoutMs });
	};
	const stockCommand = (args, input) => trackedRun(config.stockCli, stockDir, args, { input, timeoutMs: config.timeoutMs });
	async function trackedRun(...args) {
		check(!signal.aborted, 'acceptance-interrupted');
		const child = launch(...args); processes.add(child);
		try { check((await child.completion).ok, 'child-command-failed'); return child.stdout; }
		finally { processes.delete(child); }
	}
	function alive() { check(!signal.aborted, 'acceptance-interrupted'); check(!leaseLost, 'source-lease-lost'); check(daemon && !daemon.closed, 'serve-exited'); }
	const wait = (fn, code, intervalMs = 2000) => until(async () => { alive(); return fn(); }, { timeoutMs: config.timeoutMs, intervalMs, code });
	async function api(route, method = 'GET', body, token = apiToken) {
		const url = new URL(`http://127.0.0.1:${apiPort}${route}`); url.searchParams.set('token', token);
		const response = await fetch(url, {
			method, headers: body ? { 'Content-Type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000), redirect: 'error',
		});
		check(response.ok, 'api-request-failed');
		return response.json();
	}
	async function start(directory = headlessDir) {
		check(!signal.aborted, 'acceptance-interrupted');
		daemon = launch(config.headlessCli, directory, ['serve'], native); processes.add(daemon);
		await wait(async () => {
			if (!daemon.stdout.includes('headless: private API ready')) return false;
			await api('/folders'); return true;
		}, 'serve-readiness-timeout');
	}
	async function stop() {
		check((await daemon.stop()).ok, 'serve-did-not-stop-cleanly'); processes.delete(daemon);
	}
	const marker = label => `${label}${crypto.randomBytes(10).toString('hex')}`;
	async function searchable(id, text) {
		const response = await api(`/search?query=${encodeURIComponent(text)}&fields=id,body,encryption_applied`);
		return response.items?.some(item => item.id === id && item.encryption_applied === 0 && item.body?.includes(text));
	}
	async function stockHas(id, text) {
		try { return (await stockCommand(['cat', id])).includes(text); }
		catch (_error) { return false; }
	}
	async function stockLacks(id, folderId) {
		await stockCommand(['use', folderId]);
		const notes = JSON.parse(await stockCommand(['ls', '--format', 'json']));
		check(Array.isArray(notes), 'stock-note-list-unreadable');
		return !notes.some(note => note.id === id);
	}
	async function refreshStock() {
		await stockCommand(['sync']);
		await stockCommand(['e2ee', 'decrypt', '--force']);
	}
	const pass = label => record({ status: 'PASS', step: label });
	const enter = label => { stage = label; record({ status: 'START', step: label }); };
	try {
		record({ status: 'START', step: stage });
		originals = {
			headless: await copyStoppedProfile(config.headlessProfile, headlessDir),
			stock: await copyStoppedProfile(config.stockProfile, stockDir),
		};
		const headlessSettings = JSON.parse(await headlessCommand(['config', '--export', '--verbose']));
		const stockSettings = JSON.parse(await stockCommand(['config', '--export', '--verbose']));
		const keyId = validateProfileSettings(headlessSettings, config);
		check(validateProfileSettings(stockSettings, config) === keyId, 'source-master-keys-differ');
		apiToken = headlessSettings['api.token'];
		check(typeof apiToken === 'string' && apiToken.length >= 16, 'existing-api-token-required');
		check(headlessSettings['net.proxyEnabled'] !== true && stockSettings['net.proxyEnabled'] !== true, 'preexisting-network-proxy-unsupported-in-test');
		proxy = await faultProxy(config.serverUrl);
		apiPort = await unusedPort();
		await headlessCommand(['config', '--import'], JSON.stringify({
			'api.port': apiPort, 'sync.9.path': proxy.url, 'sync.interval': 300,
			'locale': 'en_GB', 'net.proxyEnabled': false,
		}));
		await stockCommand(['config', '--import'], JSON.stringify({ 'sync.interval': 0, 'locale': 'en_GB' }));
		pass('stopped-profile-clones-and-existing-e2ee');

		enter('autonomous-outbound-and-fts');
		await start();
		const originalPid = daemon.child.pid;
		const folder = await api('/folders', 'POST', { title: `Headless acceptance ${crypto.randomBytes(6).toString('hex')}` });
		const outbound = marker('outbound');
		const note = await api('/notes', 'POST', { parent_id: folder.id, title: 'Autonomous round trip', body: outbound });
		await wait(() => searchable(note.id, outbound), 'outbound-fts-timeout');
		await wait(async () => { await refreshStock(); return stockHas(note.id, outbound); }, 'autonomous-outbound-timeout', 10000);
		pass('autonomous-outbound-and-fts');

		enter('autonomous-inbound-decryption-and-fts');
		const inbound = marker('inbound');
		await stockCommand(['set', note.id, 'body', inbound]);
		await stockCommand(['sync']);
		// Only reads against the headless API here. No manual headless sync/decrypt or writes to trigger a sync.
		await wait(() => searchable(note.id, inbound), 'autonomous-inbound-timeout');
		pass('autonomous-inbound-decryption-and-fts');

		enter('outage-local-save-and-deferred-remote-change');
		proxy.setOffline(true);
		const blockedBefore = proxy.blocked;
		const incomingDuringOutage = marker('remoteoutage');
		await stockCommand(['set', note.id, 'body', incomingDuringOutage]);
		await stockCommand(['sync']);
		const localDuringOutage = marker('localoutage');
		const offlineNote = await api('/notes', 'POST', { parent_id: folder.id, title: 'Saved during outage', body: localDuringOutage });
		await wait(() => searchable(offlineNote.id, localDuringOutage), 'outage-fts-timeout');
		await wait(() => proxy.blocked > blockedBefore, 'no-real-sync-attempt-during-outage');
		check(!await searchable(note.id, incomingDuringOutage), 'fault-proxy-was-bypassed');
		await refreshStock();
		check(await stockLacks(offlineNote.id, folder.id), 'offline-note-reached-server');
		check(daemon.child.pid === originalPid, 'serve-was-replaced');
		pass('outage-local-save-and-deferred-remote-change');

		enter('autonomous-recovery-same-process');
		proxy.setOffline(false);
		// Do not signal/restart/mutate the headless process to force recovery.
		await wait(() => searchable(note.id, incomingDuringOutage), 'recovery-inbound-timeout');
		await wait(async () => { await refreshStock(); return stockHas(offlineNote.id, localDuringOutage); }, 'recovery-outbound-timeout', 10000);
		check(daemon.child.pid === originalPid, 'serve-was-replaced');
		check(proxy.redirects === 0, 'upstream-redirect-not-supported');
		pass('autonomous-recovery-same-process');

		enter('full-profile-restore-with-unsynced-note');
		proxy.setOffline(true);
		const notSynced = marker('restoreonly');
		const restoreNote = await api('/notes', 'POST', { parent_id: folder.id, title: 'Unsynchronized restore canary', body: notSynced });
		await wait(() => searchable(restoreNote.id, notSynced), 'restore-canary-fts-timeout');
		await refreshStock();
		check(await stockLacks(restoreNote.id, folder.id), 'restore-canary-already-remote');
		await stop();
		const backup = path.join(config.workDir, 'backup');
		const restored = path.join(config.workDir, 'restored');
		await copyStoppedProfile(headlessDir, backup);
		await copyStoppedProfile(backup, restored);
		const forwardedBeforeRestore = proxy.forwarded;
		await start(restored);
		await wait(() => searchable(restoreNote.id, notSynced), 'full-profile-restore-timeout');
		check(proxy.forwarded === forwardedBeforeRestore, 'restore-used-remote-server');
		await stop();
		const restoredSettings = JSON.parse(await headlessCommand(['config', '--export', '--verbose'], undefined, restored));
		check(JSON.parse(restoredSettings.syncInfoCache).activeMasterKeyId?.value === keyId, 'restored-master-key-changed');
		check(restoredSettings['api.token'] === apiToken, 'restored-token-changed');
		pass('full-profile-restore-with-unsynced-note');

		enter('protected-credential-and-source-preservation');
		const plainSettings = await fsp.readFile(path.join(restored, 'settings.json'), 'utf8');
		const sensitive = [apiToken, headlessSettings['sync.9.password'], headlessSettings['sync.9.apiKey'], headlessSettings['encryption.masterPassword'], ...Object.values(headlessSettings['encryption.passwordCache'] || {})];
		for (const value of sensitive) {
			if (typeof value === 'string' && value) check(!plainSettings.includes(value) && !plainSettings.includes(JSON.stringify(value).slice(1, -1)), 'credential-present-in-plaintext-settings');
		}
		check(JSON.stringify(originals.headless) === JSON.stringify(await inventory(config.headlessProfile)), 'original-headless-profile-changed');
		check(JSON.stringify(originals.stock) === JSON.stringify(await inventory(config.stockProfile)), 'original-stock-profile-changed');
		pass('protected-credential-and-source-preservation');
		return { status: 'PASS', scope: 'real-compiled-clients-existing-e2ee-test-account', steps: 7 };
	} catch (_error) {
		record({ status: 'FAIL', step: stage, reason: _error instanceof GateError ? _error.message : 'runtime-operation-failed' });
		// Do not surface native/HTTP/JSON diagnostics, which can contain account data.
		throw new GateError(`acceptance-incomplete-${stage}`);
	} finally {
		signal.removeEventListener('abort', onAbort);
		for (const child of processes) await child.stop();
		if (proxy) await proxy.close();
		await release();
		// Outputs and profiles remain private; no account recovery state is reset or exported.
	}
}

async function main() {
	process.umask(0o077);
	const events = [];
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on('SIGINT', interrupt);
	process.on('SIGTERM', interrupt);
	try {
		const config = readConfiguration(process.argv[2]);
		await fsp.mkdir(config.workDir, { mode: 0o700 });
		const record = event => { events.push(event); console.log(`${event.status} ${event.step}${event.reason ? ` (${event.reason})` : ''}`); };
		try {
			const result = await acceptance(config, record, controller.signal);
			await fsp.writeFile(path.join(config.workDir, 'acceptance-report.json'), JSON.stringify({ ...result, events }, null, 2), { mode: 0o600 });
			console.log('PASS autonomous-acceptance');
		} catch (_error) {
			if (fs.existsSync(config.workDir)) await fsp.writeFile(path.join(config.workDir, 'acceptance-report.json'), JSON.stringify({ status: 'FAIL', events }, null, 2), { mode: 0o600 });
			throw _error;
		}
	} catch (_error) {
		if (_error instanceof GateError) console.error(`FAIL ${_error.message}`);
		console.error('FAIL acceptance-not-complete; use the last step name and private local state for diagnosis. Do not share profile data or keys.');
		process.exitCode = 1;
	} finally {
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', interrupt);
	}
}
if (require.main === module) void main();
module.exports = { readConfiguration, validateProfileSettings, acceptance };
