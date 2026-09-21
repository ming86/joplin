#!/usr/bin/env node
import { loadFleetConfig } from './src/fleet/config.mjs';
import { startFleet } from './src/fleet/supervisor.mjs';
import { safeCode } from './src/fleet/files.mjs';
import { requireValue } from './src/errors.mjs';
let fleet, stop;
const stopped = new Promise(resolve => { stop = resolve; });
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
	requireValue(process.argv.length === 3, 'usage_node_fleet_mjs_config');
	fleet = await startFleet(loadFleetConfig(process.argv[2]));
	console.error('fleet: operator socket ready; query status for individual accounts');
	await stopped;
} catch (error) { console.error(`Fleet failed: ${safeCode(error)}`); process.exitCode = 1; }
finally { try { await fleet?.close(); } catch { console.error('Fleet shutdown failed'); process.exitCode = 1; } }
