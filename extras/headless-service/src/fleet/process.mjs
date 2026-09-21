import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { privateFd } from './files.mjs';
import { ServiceError } from '../errors.mjs';

// No shell, secrets in argv, inherited Node injection flags or shared key FDs.
export function childEnvironment() {
	return Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH', 'NODE_PATH'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}
export function launchCore(config, args = ['serve'], { interactive = false } = {}) {
	const fd = privateFd(config.databaseKeyFile, 128);
	try {
		const child = spawn(process.execPath, [config.cliPath, ...args], {
			env: { ...childEnvironment(), JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: config.profilePath, JOPLIN_HEADLESS_SQLITE_MODULE: config.sqliteModule, JOPLIN_HEADLESS_KEY_FD: '3' },
			stdio: interactive ? ['inherit', 'inherit', 'inherit', fd] : ['ignore', 'pipe', 'ignore', fd],
		});
		let exited = false;
		const done = new Promise(resolve => { child.once('error', () => { exited = true; resolve({ code: 1, signal: null }); }); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
		let ready = false, text = '';
		child.stdout?.on('data', b => {
			// Consume and discard core output; only the fixed readiness marker is read.
			text += b.toString('utf8'); let end;
			while ((end = text.indexOf('\n')) >= 0) {
				const line = text.slice(0, end).trim(); text = text.slice(end + 1);
				if (line === 'headless: private API ready; synchronization and decryption may still be pending') ready = true;
			}
			if (text.length > 4096) text = '';
		});
		return { child, done, get exited() { return exited; }, get ready() { return ready; }, async close() {
			if (exited) return done;
			child.kill('SIGTERM'); const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 35000);
			try { return await done; } finally { clearTimeout(timer); }
		} };
	} finally { fs.closeSync(fd); }
}
export async function requireUnusedPort(port) {
	const occupied = await new Promise(resolve => {
		const s = net.connect({ port, host: '127.0.0.1' });
		const finish = value => { s.destroy(); resolve(value); };
		s.once('connect', () => finish(true)); s.once('error', () => finish(false)); s.setTimeout(1000, () => finish(true));
	});
	if (occupied) throw new ServiceError('account_port_already_in_use');
}
export async function waitForCore(core, account, timeoutMs, signal) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (signal.aborted) throw new ServiceError('account_start_cancelled');
		if (core.exited) throw new ServiceError('core_start_failed');
		if (core.ready) {
			try { await account.listNotebooks({ limit: 1 }, AbortSignal.any([signal, AbortSignal.timeout(1000)])); return; } catch {}
		}
		await delay(100, undefined, { signal });
	}
	throw new ServiceError('core_start_timeout');
}
