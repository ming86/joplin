#!/usr/bin/env node
import { connectPrivateSocket, firstLine } from './src/fleet/socket.mjs';
import { privateJson, privateText, object, safeCode } from './src/fleet/files.mjs';
import { requireValue } from './src/errors.mjs';
let socket;
try {
	requireValue(process.argv.length === 3, 'usage_mcp_connect_config');
	const c = object(privateJson(process.argv[2]), ['socketPath', 'tokenFile']);
	const token = privateText(c.tokenFile, 4096).trim();
	requireValue(/^[A-Za-z0-9_-]{32,256}$/.test(token), 'invalid_mcp_credential');
	socket = await connectPrivateSocket(c.socketPath);
	const hello = firstLine(socket, { maxBytes: 512 }); socket.write(JSON.stringify({ token }) + '\n');
	requireValue((await hello)?.authenticated === true, 'mcp_authentication_failed');
	const done = new Promise(resolve => { socket.once('close', resolve); socket.once('error', () => { process.exitCode = 1; resolve(); }); });
	const stop = () => socket.destroy(); process.once('SIGTERM', stop); process.once('SIGINT', stop);
	process.stdout.on('error', stop); process.stdin.on('error', stop);
	socket.pipe(process.stdout); process.stdin.pipe(socket); socket.resume();
	await done; process.stdin.unpipe(socket); process.stdin.pause(); process.stdin.destroy();
} catch (error) { console.error(`MCP connection failed: ${safeCode(error)}`); process.exitCode = 1; }
finally { socket?.destroy(); }
