const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { check, until, launch, normalizedServerUrl, faultProxy, inventory, copyStoppedProfile } = require('./acceptance/helpers.cjs');
const { readConfiguration, validateProfileSettings } = require('./acceptance/run.cjs');

async function temporary(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-harness-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}
async function origin(t, handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
	return `http://127.0.0.1:${server.address().port}`;
}

test('acceptance fault proxy forwards fixed-origin paths/body and blocks/re-enables requests', async t => {
	const hits = [];
	const upstream = await origin(t, async (req, res) => {
		let body = ''; for await (const chunk of req) body += chunk;
		hits.push({ path: req.url, body, host: req.headers.host });
		res.end(JSON.stringify({ ok: true }));
	});
	const proxy = await faultProxy(`${upstream}/joplin`); t.after(() => proxy.close());
	let response = await fetch(`${proxy.url}/api/items`, { method: 'POST', body: 'synthetic-body' });
	assert.equal(response.status, 200); await response.text();
	assert.deepEqual(hits[0], { path: '/joplin/api/items', body: 'synthetic-body', host: new URL(upstream).host });
	proxy.setOffline(true);
	response = await fetch(`${proxy.url}/api/items`);
	assert.equal(response.status, 503); await response.text();
	assert.equal(hits.length, 1); assert.equal(proxy.blocked, 1);
	proxy.setOffline(false);
	response = await fetch(`${proxy.url}/api/items`); await response.text();
	assert.equal(response.status, 200); assert.equal(proxy.forwarded, 2);
});

test('acceptance fault proxy rejects redirects instead of allowing an outage bypass', async t => {
	const upstream = await origin(t, (req, res) => { res.writeHead(302, { location: 'https://example.invalid/bypass' }); res.end(); });
	const proxy = await faultProxy(upstream); t.after(() => proxy.close());
	const response = await fetch(proxy.url); await response.text();
	assert.equal(response.status, 502); assert.equal(proxy.redirects, 1);
});

test('going offline aborts an already in-flight proxy connection', async t => {
	let requestStarted;
	const started = new Promise(resolve => { requestStarted = resolve; });
	const upstream = await origin(t, () => { requestStarted(); });
	const proxy = await faultProxy(upstream); t.after(() => proxy.close());
	const pending = fetch(`${proxy.url}/api/items`);
	const rejected = assert.rejects(pending);
	await started; proxy.setOffline(true); await rejected;
});

test('full-profile copy includes settings/resources/WAL and matches every file', async t => {
	const dir = await temporary(t); const source = path.join(dir, 'source');
	await fs.mkdir(path.join(source, 'resources'), { recursive: true });
	await fs.writeFile(path.join(source, 'database.sqlite'), 'synthetic encrypted database');
	await fs.writeFile(path.join(source, 'database.sqlite-wal'), 'synthetic wal');
	await fs.writeFile(path.join(source, 'settings.json'), '{"api.port":41184}');
	await fs.writeFile(path.join(source, 'resources', 'public.txt'), 'ordinary plaintext is allowed');
	const copied = path.join(dir, 'restored');
	await copyStoppedProfile(source, copied);
	assert.deepEqual(await inventory(source), await inventory(copied));
	await assert.rejects(copyStoppedProfile(source, copied), /already-exists/);
});

test('profile copier rejects a symlink rather than following it outside the selected profile', async t => {
	const dir = await temporary(t); const source = path.join(dir, 'source'); await fs.mkdir(source);
	await fs.writeFile(path.join(source, 'database.sqlite'), 'db');
	await fs.symlink('/etc/passwd', path.join(source, 'escape'));
	await assert.rejects(copyStoppedProfile(source, path.join(dir, 'copy')), /link-or-special-file/);
});

test('process launcher passes the key on FD3, preserves Unicode, strips inherited headless config from stock', async t => {
	const dir = await temporary(t); const entry = path.join(dir, 'fixture.cjs'); const key = path.join(dir, 'key');
	await fs.writeFile(key, 'a'.repeat(64), { mode: 0o600 });
	await fs.writeFile(entry, `
		const fs = require('fs');
		if(process.env.JOPLIN_HEADLESS) {
			if(fs.readFileSync(3,'utf8') !== 'a'.repeat(64)) process.exit(2);
			if(process.env.JOPLIN_HEADLESS_KEY_FD !== '3') process.exit(3);
			const b=Buffer.from('中文✓');
			let i=0; const timer=setInterval(()=> { process.stdout.write(b.subarray(i,i+1)); if(++i===b.length) clearInterval(timer); }, 1);
		} else process.stdout.write(process.argv.includes('--profile') ? 'stock' : 'bad');
	`);
	const child = launch(entry, dir, ['serve'], { sqliteModule: '/placeholder', keyFile: key, timeoutMs: 5000 });
	assert.equal((await child.completion).ok, true); assert.equal(child.stdout, '中文✓');
	process.env.JOPLIN_HEADLESS = 'bad-inherited-value';
	try {
		const stock = launch(entry, dir, ['status'], { timeoutMs: 5000 });
		assert.equal((await stock.completion).ok, true); assert.equal(stock.stdout, 'stock');
	} finally { delete process.env.JOPLIN_HEADLESS; }
});

test('process stop is idempotent and waits for clean signal handling', async t => {
	const dir = await temporary(t); const entry = path.join(dir, 'fixture.cjs');
	await fs.writeFile(entry, `const t=setInterval(()=>{},1000); process.on('SIGTERM',()=>{clearInterval(t); process.exitCode=0;}); console.log('ready');`);
	const child = launch(entry, dir, [], { timeoutMs: 5000 });
	await until(() => child.stdout.includes('ready'), { timeoutMs: 5000, intervalMs: 5 });
	const [first, second] = await Promise.all([child.stop(), child.stop()]);
	assert.equal(first.ok, true); assert.deepEqual(first, second); assert.equal(child.closed, true);
});

test('existing test account/E2EE identity is required, not generated or reset', () => {
	const config = { serverUrl: 'https://test.invalid', expectedUsername: 'synthetic@example.invalid' };
	const settings = {
		'sync.target': 9, 'sync.9.path': 'https://test.invalid/', 'sync.9.username': config.expectedUsername,
		syncInfoCache: JSON.stringify({ e2ee: { value: true }, activeMasterKeyId: { value: 'unchanged-id' } }),
	};
	assert.equal(validateProfileSettings(settings, config), 'unchanged-id');
	assert.throws(() => validateProfileSettings({ ...settings, 'sync.9.username': 'other' }, config), /unexpected-test-account/);
	assert.throws(() => validateProfileSettings({ ...settings, syncInfoCache: '{}' }, config), /existing-e2ee/);
	assert.throws(() => validateProfileSettings({ ...settings, 'sync.target': 10 }, config), /only-existing/);
});

test('test config requires explicit opt-in and refuses work/key placement inside source profiles', async t => {
	const dir = await temporary(t);
	const configPath = path.join(dir, 'config.json');
	const config = { allowTestAccountWrites: true, sourcesStopped: true, expectedServerUrl: 'https://test.invalid', expectedUsername: 'test@example.invalid', workDir: path.join(dir, 'new-run') };
	for (const name of ['headlessCli', 'stockCli', 'databaseKeyFile', 'sqliteModule']) {
		config[name] = path.join(dir, name); await fs.writeFile(config[name], name === 'databaseKeyFile' ? 'b'.repeat(64) : 'fixture', { mode: 0o600 });
	}
	for (const name of ['headlessProfile', 'stockProfile']) { config[name] = path.join(dir, name); await fs.mkdir(config[name]); }
	async function write(value) { await fs.writeFile(configPath, JSON.stringify(value), { mode: 0o600 }); }
	await write(config); assert.equal(readConfiguration(configPath).timeoutMs, 900000);
	await write({ ...config, allowTestAccountWrites: false }); assert.throws(() => readConfiguration(configPath), /confirmation-required/);
	await write({ ...config, workDir: path.join(config.headlessProfile, 'new-run') }); assert.throws(() => readConfiguration(configPath), /outside-source/);
	await write(config); await fs.chmod(configPath, 0o644); assert.throws(() => readConfiguration(configPath), /must-be-private/);
});

test('test URL parsing rejects embedded credentials and query strings', () => {
	assert.equal(normalizedServerUrl('https://test.invalid/path/'), 'https://test.invalid/path');
	assert.throws(() => normalizedServerUrl('https://user:secret@test.invalid'), /invalid-server-url/);
	assert.throws(() => normalizedServerUrl('https://test.invalid/?secret=x'), /invalid-server-url/);
	assert.throws(() => check(false, 'safe-code'), /safe-code/);
});

test('SIMULATED CLIs exercise the entire acceptance sequence, not real Joplin/E2EE', { timeout: 60000 }, async t => {
	const { acceptance } = require('./acceptance/run.cjs');
	const dir = await temporary(t);
	const remote = { notes: {}, folders: {} };
	const serverUrl = await origin(t, async (req, res) => {
		let body = ''; for await (const chunk of req) body += chunk;
		const local = JSON.parse(body);
		for (const [id, item] of Object.entries(local.notes)) if (!remote.notes[id] || remote.notes[id].updated < item.updated) remote.notes[id] = item;
		Object.assign(remote.folders, local.folders);
		res.end(JSON.stringify(remote));
	});
	const settings = {
		'sync.target': 9, 'sync.9.path': serverUrl, 'sync.9.username': 'fixture@example.invalid',
		'api.token': 'synthetic-api-token-for-test-only', 'sync.9.password': 'synthetic-password',
		syncInfoCache: JSON.stringify({ e2ee: { value: true }, activeMasterKeyId: { value: 'existing-fixture-key' } }),
	};
	const config = { serverUrl, expectedUsername: settings['sync.9.username'], timeoutMs: 10000, sqliteModule: '/unused-fixture' };
	for (const name of ['headlessProfile', 'stockProfile', 'workDir']) { config[name] = path.join(dir, name); await fs.mkdir(config[name]); }
	for (const name of ['headlessProfile', 'stockProfile']) {
		await fs.writeFile(path.join(config[name], 'database.sqlite'), JSON.stringify({ settings, notes: {}, folders: {} }));
		await fs.writeFile(path.join(config[name], 'settings.json'), '{}');
	}
	const fixture = path.join(__dirname, 'fixtures', 'acceptance-cli.cjs');
	for (const name of ['headlessCli', 'stockCli']) { config[name] = path.join(dir, `${name}.cjs`); await fs.copyFile(fixture, config[name]); }
	const lockDir = path.join(dir, 'node_modules', 'proper-lockfile'); await fs.mkdir(lockDir, { recursive: true });
	await fs.writeFile(path.join(lockDir, 'index.js'), 'exports.lock = async () => async () => {}; // SIMULATED lease only');
	config.databaseKeyFile = path.join(dir, 'key'); await fs.writeFile(config.databaseKeyFile, 'a'.repeat(64), { mode: 0o600 });
	const events = [];
	const result = await acceptance(config, event => events.push(event));
	assert.equal(result.status, 'PASS');
	assert.equal(events.filter(event => event.status === 'PASS').length, 7);
	// The runner leaves only the synthetic test account changes; no test ever enables E2EE.
	assert.equal(Object.keys(remote.notes).length, 2);
	assert.ok(!Object.values(remote.notes).some(note => note.title === 'Unsynchronized restore canary'));
});
