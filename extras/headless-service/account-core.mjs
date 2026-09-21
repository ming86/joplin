#!/usr/bin/env node
// Operator-only setup wrapper. No default profile, E2EE enable/reset command,
// shell interpolation or password arguments. Stop the managed account first.
import { loadAccountDefinition, secretHashes } from './src/fleet/config.mjs';
import { launchCore } from './src/fleet/process.mjs';
import { safeCode } from './src/fleet/files.mjs';
import { requireValue } from './src/errors.mjs';
const commands = { 'import-config': ['config', '--import'], sync: ['sync'], decrypt: ['e2ee', 'decrypt'], status: ['e2ee', 'status'] };
let core;
try {
	requireValue(process.argv.length === 4 && Object.hasOwn(commands, process.argv[3]), 'usage_account_core_config_import_config_sync_decrypt_status');
	const config = loadAccountDefinition(process.argv[2]); secretHashes(config);
	core = launchCore(config.core, commands[process.argv[3]], { interactive: true });
	const stop = () => { void core.close(); }; process.once('SIGTERM', stop); process.once('SIGINT', stop);
	const result = await core.done; process.exitCode = result.code ?? 1;
} catch (error) { console.error(`Account setup failed: ${safeCode(error)}`); process.exitCode = 1; }
finally { await core?.close(); }
