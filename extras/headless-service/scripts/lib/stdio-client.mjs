// Test/reference MCP client, separate process, no server/session imports.
// This is NOT the official SDK and does not certify other hosts.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
export class StdioTestClient {
	constructor(config, executable = fileURLToPath(new URL('../../mcp.mjs', import.meta.url)), { timeoutMs = 15000 } = {}) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error('Invalid request timeout');
		this.timeoutMs = timeoutMs;
		this.child = spawn(process.execPath, [executable, config], { stdio: ['pipe', 'pipe', 'pipe'] });
		this.pending = new Map(); this.serial = 0; this.stderr = ''; let buffer = '';
		this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4096); });
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', data => {
			buffer += data;
			while (buffer.includes('\n')) {
				const i = buffer.indexOf('\n'); const frame = buffer.slice(0, i); buffer = buffer.slice(i + 1);
				let r; try { r = JSON.parse(frame); } catch { this.fail(Error('Non-JSON protocol output')); return; }
				if (r.jsonrpc !== '2.0') { this.fail(Error('Invalid JSON-RPC version')); return; }
				const p = this.pending.get(r.id); if (!p) continue; this.pending.delete(r.id); clearTimeout(p.timer);
				if (r.error) p.reject(Object.assign(Error(r.error.message), { rpcCode: r.error.code })); else p.resolve(r.result);
			}
		});
		this.child.stdin.on('error', error => this.fail(error));
		this.child.stdout.on('error', error => this.fail(error));
		this.child.on('error', error => this.fail(error));
		this.child.on('exit', () => this.fail(Error('MCP process exited')));
	}
	fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
	notify(method, params) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`); }
	request(method, params) {
		const id = ++this.serial;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(Error('MCP request timed out')); }, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
		});
	}
	async initialize() {
		const r = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'joplin-mcp-reference-client', version: '0.1' } });
		if (!['2025-11-25', '2025-06-18'].includes(r.protocolVersion) || !r.capabilities.tools) throw Error('Unsupported server capability/version');
		this.notify('notifications/initialized'); return r;
	}
	call(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }
	async close() {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const stopped = once(this.child, 'exit'); this.child.stdin.end();
		const timer = setTimeout(() => this.child.kill('SIGKILL'), 6000);
		await stopped; clearTimeout(timer);
	}
}
