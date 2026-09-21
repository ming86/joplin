import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { privateDirectory, socketPath } from './files.mjs';
import { ServiceError, requireValue } from '../errors.mjs';
import { createMcpSession } from '../mcp/session.mjs';
import { serveStdio } from '../mcp/stdio.mjs';

// One bounded first line. Pause before yielding so pipelined MCP bytes cannot
// disappear between authentication and the existing stdio frame reader.
export function firstLine(socket, { maxBytes = 2048, timeoutMs = 5000 } = {}) {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => fail(), timeoutMs);
		const clean = () => { clearTimeout(timer); socket.removeListener('data', data); socket.removeListener('error', fail); socket.removeListener('end', fail); socket.removeListener('close', fail); };
		const fail = () => { clean(); reject(new ServiceError('socket_handshake_failed')); };
		const data = part => {
			buffer = Buffer.concat([buffer, part]); const i = buffer.indexOf(10);
			if ((i < 0 && buffer.length > maxBytes) || i > maxBytes) return fail();
			if (i < 0) return;
			socket.pause(); clean();
			if (buffer.length > i + 1) socket.unshift(buffer.subarray(i + 1));
			try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, i)))); }
			catch { reject(new ServiceError('invalid_socket_request')); }
		};
		socket.on('data', data); socket.once('error', fail); socket.once('end', fail); socket.once('close', fail); socket.resume();
	});
}
export async function listenPrivateSocket(filename, handler, maxConnections = 16) {
	socketPath(filename); privateDirectory(path.dirname(filename), true);
	// Never unlink a pre-existing path: it may belong to a live owner. Stale
	// sockets require an operator's stopped-state check, not optimistic takeover.
	const connections = new Set(); let closing = false;
	const server = net.createServer(socket => {
		socket.on('error', () => {});
		if (closing || connections.size >= maxConnections) { socket.destroy(); return; }
		connections.add(socket); socket.once('close', () => connections.delete(socket));
		Promise.resolve(handler(socket)).catch(() => socket.destroy());
	});
	try {
		await new Promise((resolve, reject) => { server.once('error', reject); server.listen(filename, resolve); });
		fs.chmodSync(filename, 0o600);
	} catch (error) { if (server.listening) server.close(); throw error; }
	let promise;
	return { close() {
		if (promise) return promise; closing = true;
		for (const c of connections) c.destroy();
		promise = new Promise(resolve => server.close(resolve)); return promise;
	} };
}
const digest = s => createHash('sha256').update(s).digest();
export async function startMcpSocket({ socketPath: filename, token, service, allowWrites }) {
	requireValue(/^[A-Za-z0-9_-]{32,256}$/.test(token), 'invalid_mcp_credential');
	const expected = digest(token), transports = new Set();
	const server = await listenPrivateSocket(filename, async socket => {
		const hello = await firstLine(socket, { maxBytes: 512 });
		if (!hello || Object.keys(hello).length !== 1 || typeof hello.token !== 'string' || hello.token.length > 256 || !timingSafeEqual(digest(hello.token), expected)) { socket.end('{"authenticated":false}\n'); return; }
		socket.write('{"authenticated":true}\n');
		const transport = serveStdio(createMcpSession(service, { allowWrites }), { input: socket, output: socket });
		transports.add(transport);
		socket.once('close', () => { void transport.close(); });
		transport.done.then(() => { transports.delete(transport); socket.end(); }); socket.resume();
	});
	return { async close() { const closing = [...transports].map(t => t.close()); await server.close(); await Promise.allSettled(closing); } };
}
export async function connectPrivateSocket(filename) {
	socketPath(filename);
	const socket = net.connect(filename); socket.on('error', () => {});
	await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
	return socket;
}
