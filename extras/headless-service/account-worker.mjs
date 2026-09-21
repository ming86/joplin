#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { loadAccountDefinition, secretHashes } from './src/fleet/config.mjs';
import { startAccount } from './src/fleet/account.mjs';
import { safeCode } from './src/fleet/files.mjs';
import { requireValue } from './src/errors.mjs';

const abort = new AbortController(); let finish, runtime;
const stopped = new Promise(resolve => { finish = resolve; });
const stop = () => { abort.abort(); finish(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop); process.once('disconnect', stop);
const report = value => { if (process.connected) process.send(value, () => {}); };
try {
	requireValue(process.argv.length === 4 && process.send, 'managed_worker_required');
	const definition = loadAccountDefinition(process.argv[2]);
	requireValue(createHash('sha256').update(JSON.stringify(definition)).digest('hex') === process.argv[3], 'fleet_configuration_changed');
	secretHashes(definition);
	runtime = await startAccount(definition, { signal: abort.signal, onCoreExit: () => { process.exitCode = 1; stop(); } });
	if (!abort.signal.aborted) report({ state: 'running', corePid: runtime.corePid });
	await stopped;
} catch (error) { report({ state: 'failed', reason: safeCode(error) }); process.exitCode = abort.signal.aborted ? process.exitCode : 1; }
finally {
	try { await runtime?.close(); } catch { process.exitCode = 1; }
	if (process.connected) process.disconnect();
}
