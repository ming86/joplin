// Test-only process and network helpers. No private account data is written to logs.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

class GateError extends Error {}
function check(condition, code) {
	if (!condition) throw new GateError(code);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(checkFn, { timeoutMs = 900000, intervalMs = 2000, code = 'deadline-exceeded' } = {}) {
	const deadline = Date.now() + timeoutMs;
	do {
		if (await checkFn()) return;
		await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
	} while (Date.now() < deadline);
	throw new GateError(code);
}

function launch(entry, profile, args, { sqliteModule, keyFile, input, timeoutMs } = {}) {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (name.startsWith('JOPLIN_HEADLESS')) delete env[name];
	let keyFd;
	if (keyFile) {
		Object.assign(env, {
			JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: profile,
			JOPLIN_HEADLESS_KEY_FD: '3', JOPLIN_HEADLESS_SQLITE_MODULE: sqliteModule,
		});
		keyFd = fs.openSync(keyFile, 'r');
	}
	let child;
	try {
		child = spawn(process.execPath, [entry, ...(keyFile ? [] : ['--profile', profile, '--no-welcome']), ...args], {
			env, stdio: ['pipe', 'pipe', 'pipe', ...(keyFd === undefined ? [] : [keyFd])],
		});
	} finally {
		if (keyFd !== undefined) fs.closeSync(keyFd);
	}
	let stdout = '';
	let bytes = 0;
	let failed = false;
	let closed = false;
	let timer;
	let stopPromise;
	// Cap captured output; never surface raw process diagnostics in the report.
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		bytes += Buffer.byteLength(chunk);
		if (bytes <= 16 * 1024 * 1024) stdout += chunk.toString();
		else { failed = true; child.kill('SIGKILL'); }
	});
	child.stderr.on('data', chunk => {
		bytes += chunk.length;
		if (bytes > 16 * 1024 * 1024) { failed = true; child.kill('SIGKILL'); }
	});
	child.stdin.on('error', () => {});
	child.on('error', () => { failed = true; });
	const completion = new Promise(resolve => child.on('close', (code, signal) => {
		closed = true;
		clearTimeout(timer);
		resolve({ ok: !failed && code === 0 && !signal, code, signal });
	}));
	if (timeoutMs) timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, timeoutMs);
	child.stdin.end(input);
	return {
		child, completion,
		get stdout() { return stdout; },
		get closed() { return closed; },
		async stop() {
			if (stopPromise) return stopPromise;
			stopPromise = completion;
			clearTimeout(timer);
			if (!closed) {
				child.kill('SIGTERM');
				timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 35000);
			}
			return completion;
		},
	};
}

function normalizedServerUrl(raw) {
	const url = new URL(raw);
	check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'invalid-server-url');
	return url.href.replace(/\/+$/, '');
}

// Fixed-destination fault proxy; never accepts a caller-selected upstream or logs headers/bodies.
async function faultProxy(serverUrl) {
	const upstream = new URL(normalizedServerUrl(serverUrl));
	let offline = false;
	let blocked = 0;
	let forwarded = 0;
	let redirects = 0;
	const requests = new Set();
	const sockets = new Set();
	const server = http.createServer((req, res) => {
		if (offline) { blocked++; req.resume(); res.writeHead(503); res.end('test outage'); return; }
		if (!req.url.startsWith('/') || req.url.startsWith('//')) { req.resume(); res.writeHead(400); res.end(); return; }
		forwarded++;
		const headers = { ...req.headers, host: upstream.host, connection: 'close' };
		delete headers['proxy-authorization'];
		const outgoing = (upstream.protocol === 'https:' ? https : http).request({
			protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port,
			path: req.url, method: req.method, headers, timeout: 30000,
		}, response => {
			// Do not allow redirects to silently bypass fault injection.
			if (response.statusCode >= 300 && response.statusCode < 400) {
				redirects++; response.resume(); res.writeHead(502); res.end('redirect unsupported by test'); return;
			}
			res.writeHead(response.statusCode, response.headers);
			response.pipe(res);
		});
		requests.add(outgoing);
		outgoing.on('close', () => requests.delete(outgoing));
		outgoing.on('timeout', () => outgoing.destroy());
		outgoing.on('error', () => {
			if (!res.headersSent) res.writeHead(502);
			if (!res.writableEnded) res.end();
		});
		req.on('aborted', () => outgoing.destroy());
		req.pipe(outgoing);
	});
	server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return {
		url: `http://127.0.0.1:${server.address().port}${upstream.pathname.replace(/\/+$/, '')}`,
		get blocked() { return blocked; }, get forwarded() { return forwarded; }, get redirects() { return redirects; },
		setOffline(value) {
			offline = value;
			if (offline) {
				for (const request of requests) request.destroy();
				for (const socket of sockets) socket.destroy();
			}
		},
		async close() {
			for (const request of requests) request.destroy();
			for (const socket of sockets) socket.destroy();
			await new Promise(resolve => server.close(resolve));
		},
	};
}

// The test uses complete stopped profile copies, not a database-only export.
// Reject links/special files instead of following them outside the selected directory.
async function inventory(root) {
	const result = {};
	async function visit(dir, prefix = '') {
		for (const name of (await fsp.readdir(dir)).sort()) {
			const filename = path.join(dir, name);
			const relative = path.join(prefix, name);
			const stat = await fsp.lstat(filename);
			check(stat.isFile() || stat.isDirectory(), 'profile-has-link-or-special-file');
			if (stat.isDirectory()) { result[`${relative}/`] = 'directory'; await visit(filename, relative); }
			else {
				const hash = crypto.createHash('sha256');
				for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
				result[relative] = hash.digest('hex');
			}
		}
	}
	await visit(root);
	return result;
}

async function copyStoppedProfile(source, destination) {
	check(!fs.existsSync(destination), 'copy-destination-already-exists');
	const before = await inventory(source);
	check(before['database.sqlite'], 'source-profile-has-no-database');
	await fsp.cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
	check(JSON.stringify(before) === JSON.stringify(await inventory(source)), 'source-changed-during-copy');
	check(JSON.stringify(before) === JSON.stringify(await inventory(destination)), 'profile-copy-differs');
	return before;
}

module.exports = { GateError, check, sleep, until, launch, normalizedServerUrl, faultProxy, inventory, copyStoppedProfile };
