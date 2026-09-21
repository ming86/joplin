#!/usr/bin/env node
import { connectPrivateSocket, firstLine } from './src/fleet/socket.mjs';
import { safeCode } from './src/fleet/files.mjs';
import { requireValue } from './src/errors.mjs';
let socket;
try {
	requireValue(process.argv.length === 4 || process.argv.length === 5, 'usage_fleetctl_socket_action_account');
	const [, , filename, action, accountId] = process.argv;
	socket = await connectPrivateSocket(filename);
	const reply = firstLine(socket, { maxBytes: 32768, timeoutMs: 720000 });
	socket.write(JSON.stringify({ action, ...(accountId ? { accountId } : {}) }) + '\n');
	const result = await reply; console.log(JSON.stringify(result, null, 2));
	if (!result.ok || result.state === 'failed' || result.state === 'retry_wait') process.exitCode = 1;
} catch (error) { console.error(`Operator request failed: ${safeCode(error)}`); process.exitCode = 1; }
finally { socket?.destroy(); }
