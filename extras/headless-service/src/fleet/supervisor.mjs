import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadAccountDefinition, checkSecrets } from './config.mjs';
import { privateDirectory, privateJson, object, writeJson, safeCode } from './files.mjs';
import { childEnvironment } from './process.mjs';
import { listenPrivateSocket, firstLine } from './socket.mjs';
import { requireValue, ServiceError } from '../errors.mjs';
const workerEntry = fileURLToPath(new URL('../../account-worker.mjs', import.meta.url));
const groupSignal = (child, signal) => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch {} } };

export async function startFleet(config) {
	privateDirectory(config.stateDir, true); privateDirectory(config.runtimeDir, true);
	const lockPath = path.join(config.stateDir, 'fleet.lock');
	const lock = fs.openSync(lockPath, 'wx', 0o600); fs.writeFileSync(lock, `${process.pid}\n`);
	let closed = false, control, closePromise;
	const active = new Map(), accounts = new Map();
	const stateFile = path.join(config.stateDir, 'access.json'); let access;
	const isDisabled = id => access?.disabled[id] === true;
	async function close() {
		if (closePromise) return closePromise; closed = true;
		closePromise = (async () => {
			const controlClose = control?.close();
			for (const a of accounts.values()) { a.desired = false; clearTimeout(a.retry); }
			await Promise.allSettled([...accounts.values()].map(a => stop(a)));
			await controlClose;
			try { fs.unlinkSync(lockPath); } finally { fs.closeSync(lock); }
		})(); return closePromise;
	}
	function publicState(a) { return { accountId: a.definition.id, state: a.state, disabled: isDisabled(a.definition.id), restarts: a.failures, ...(a.reason ? { reason: a.reason } : {}), ...(a.child?.pid ? { workerPid: a.child.pid } : {}), ...(a.corePid ? { corePid: a.corePid } : {}) }; }
	function serial(a, action) { const pending = a.queue.catch(() => {}).then(action); a.queue = pending; return pending; }
	async function start(a) {
		if (a.child || !a.desired || closed || isDisabled(a.definition.id)) return;
		a.reason = undefined; a.state = 'starting';
		let child;
		try {
			const definition = loadAccountDefinition(a.definition.filename);
			requireValue(JSON.stringify(definition) === JSON.stringify(a.definition), 'fleet_configuration_changed_restart_required');
			active.set(definition.id, checkSecrets(definition, config.accounts, active));
			const hash = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
			child = spawn(process.execPath, [workerEntry, definition.filename, hash], { env: childEnvironment(), detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
			a.child = child;
			let exited = false;
			a.done = new Promise(resolve => {
				const finish = () => {
					if (exited) return; exited = true;
					// Also reap an orphan core if its account worker died unexpectedly.
					groupSignal(child, 'SIGKILL');
					a.child = null; a.corePid = null; active.delete(definition.id); resolve();
					if (!closed && a.desired && !isDisabled(definition.id)) {
						a.failures++; a.state = 'failed'; a.reason ??= 'account_worker_exited';
						if (a.failures <= (config.restartLimit ?? 3)) {
							a.state = 'retry_wait'; a.retry = setTimeout(() => { void serial(a, () => start(a)).catch(() => {}); }, Math.min(1000 * 2 ** (a.failures - 1), 30000));
						}
					}
				};
				child.once('error', finish); child.once('exit', finish);
			});
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => { groupSignal(child, 'SIGKILL'); reject(new ServiceError('account_start_timeout')); }, (definition.startupTimeoutMs ?? 120000) + 5000);
				const message = value => {
					if (value?.state === 'running' && Number.isSafeInteger(value.corePid)) { a.corePid = value.corePid; clean(); resolve(); }
					if (value?.state === 'failed') { a.reason = typeof value.reason === 'string' && /^[a-z_]{1,100}$/.test(value.reason) ? value.reason : 'account_start_failed'; clean(); reject(new ServiceError(a.reason)); }
				};
				const clean = () => { clearTimeout(timer); child.removeListener('message', message); };
				child.on('message', message); a.done.then(() => { clean(); reject(new ServiceError(a.reason ?? 'account_start_failed')); });
			});
			if (a.child && a.desired && !closed) a.state = 'running';
		} catch (error) {
			a.reason = safeCode(error);
			if (child) { groupSignal(child, 'SIGTERM'); const timer = setTimeout(() => groupSignal(child, 'SIGKILL'), 50000); await a.done; clearTimeout(timer); }
			else { a.state = 'failed'; active.delete(a.definition.id); }
		}
	}
	async function stop(a) {
		a.desired = false; clearTimeout(a.retry);
		if (a.child) {
			a.state = 'stopping'; const child = a.child;
			// Ask the account worker to close public access before draining its core.
			child.kill('SIGTERM');
			const timer = setTimeout(() => groupSignal(child, 'SIGKILL'), 50000);
			await a.done; clearTimeout(timer);
		}
		a.state = isDisabled(a.definition.id) ? 'disabled' : 'stopped'; a.reason = undefined;
	}
	async function command(input) {
		object(input, ['action', 'accountId'], 'invalid_operator_command');
		requireValue(['status', 'start', 'stop', 'restart', 'disable', 'enable'].includes(input.action), 'invalid_operator_command');
		if (closed) throw new ServiceError('fleet_stopping');
		if (input.action === 'status') {
			if (input.accountId === undefined) return { accounts: [...accounts.values()].map(publicState) };
			const a = accounts.get(input.accountId); requireValue(a, 'account_not_available'); return publicState(a);
		}
		const a = accounts.get(input.accountId); requireValue(a, 'account_not_available');
		// A stop/disable must cancel a pending startup, not queue behind its long
		// unlock timeout. Persist disable before signalling the account worker.
		if (input.action === 'disable') {
			const next = structuredClone(access); next.disabled[input.accountId] = true;
			writeJson(stateFile, next); access = next;
		}
		if (['stop', 'restart', 'disable'].includes(input.action)) {
			a.desired = false; clearTimeout(a.retry); if (a.state === 'starting') a.child?.kill('SIGTERM');
		}
		return serial(a, async () => {
			if (closed) throw new ServiceError('fleet_stopping');
			if (input.action === 'disable' || input.action === 'enable') {
				// Persist revocation before stopping. No note/profile/index data is removed.
				const next = structuredClone(access); next.disabled[input.accountId] = input.action === 'disable';
				writeJson(stateFile, next); access = next;
			}
			if (['disable', 'stop', 'restart'].includes(input.action)) await stop(a);
			if (['start', 'restart', 'enable'].includes(input.action)) {
				requireValue(!isDisabled(input.accountId), 'account_disabled');
				a.desired = true; a.failures = 0; clearTimeout(a.retry); await start(a);
			}
			return publicState(a);
		});
	}
	try {
		access = fs.existsSync(stateFile) ? privateJson(stateFile) : { version: 1, disabled: {} };
		object(access, ['version', 'disabled']); requireValue(access.version === 1, 'invalid_access_state');
		requireValue(access.disabled && typeof access.disabled === 'object' && !Array.isArray(access.disabled) && Object.entries(access.disabled).every(([k,v]) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(k) && typeof v === 'boolean'), 'invalid_access_state');
		for (const definition of config.accounts) accounts.set(definition.id, { definition, desired: !isDisabled(definition.id), state: isDisabled(definition.id) ? 'disabled' : 'stopped', failures: 0, queue: Promise.resolve(), child: null });
		control = await listenPrivateSocket(path.join(config.runtimeDir, 'control.sock'), async socket => {
			try { const input = await firstLine(socket); const result = await command(input); if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, ...result }) + '\n'); }
			catch (error) { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: safeCode(error) }) + '\n'); }
		});
		// A missing key, bad binding or unavailable model is isolated to its worker.
		for (const a of accounts.values()) void serial(a, () => start(a)).catch(() => {});
		return { command, close };
	} catch (error) { await close(); throw error; }
}
