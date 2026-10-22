const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const load = require('./loadSource.cjs');
const { readHeadlessConfig, readDatabaseKey, headlessArgv } = load('packages/app-cli/app/headless/config.ts');
const { prepareProfile, createProfileDirectory } = load('packages/app-cli/app/headless/profile.ts');

function temporaryDirectory(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-headless-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function descriptor(t, content) {
	const filename = path.join(temporaryDirectory(t), 'key');
	fs.writeFileSync(filename, content, { mode: 0o600 });
	return fs.openSync(filename, 'r');
}

test('ordinary CLI remains opt-out; headless configuration requires explicit profile and descriptor', t => {
	assert.equal(readHeadlessConfig({}), null);
	for (const env of [
		{ JOPLIN_HEADLESS: '0' },
		{ JOPLIN_HEADLESS: '1' },
		{ JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: '/' },
		{ JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: 'relative' },
		{ JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: temporaryDirectory(t), JOPLIN_HEADLESS_KEY_FD: '0' },
		{ JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: temporaryDirectory(t), JOPLIN_HEADLESS_KEY_FD: '3', JOPLIN_HEADLESS_SQLITE_MODULE: 'untrusted-relative-name' },
	]) assert.throws(() => readHeadlessConfig(env));
});

test('key comes from a consumed descriptor, not argv/environment; buffer is independent', t => {
	const fd = descriptor(t, `${'ab'.repeat(32)}\n`);
	const env = { JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: temporaryDirectory(t), JOPLIN_HEADLESS_KEY_FD: `${fd}` };
	const config = readHeadlessConfig(env);
	assert.equal(config.databaseKey.toString('hex'), 'ab'.repeat(32));
	assert.equal(config.sqliteModule, 'sqlite3');
	assert.equal(config.syncIntervalSeconds, 15);
	assert.equal(env.JOPLIN_HEADLESS_KEY_FD, undefined);
	assert.throws(() => fs.fstatSync(fd));
	config.databaseKey.fill(0);
});

test('key parser rejects short, oversized, malformed and multiple keys without echoing inputs', t => {
	for (const value of ['', 'secret-password', 'ab'.repeat(31), 'z'.repeat(64), 'ab'.repeat(64), `${'ab'.repeat(32)}\n${'cd'.repeat(32)}`]) {
		const fd = descriptor(t, value);
		assert.throws(() => readDatabaseKey(fd), error => {
			assert.match(error.message, /Cannot read the database key/);
			if (value.length > 10) assert.ok(!error.message.includes(value));
			return true;
		});
		assert.throws(() => fs.fstatSync(fd));
	}
});

test('headless argv fixes production profile/log policy and defaults to serve', () => {
	const profileDir = '/dedicated/account-a';
	assert.deepEqual(headlessArgv(['node', 'main'], { profileDir }), ['node', 'main', '--profile', profileDir, '--no-welcome', '--log-level', 'none', 'serve']);
	assert.deepEqual(headlessArgv(['node', 'main', 'config', '--import'], { profileDir }).slice(-2), ['config', '--import']);
	for (const command of [['--profile', '/other'], ['--env', 'dev'], ['server', 'start']]) {
		assert.throws(() => headlessArgv(['node', 'main', ...command], { profileDir }));
	}
});

test('fresh profile gets a non-secret format marker and supports reopening', async t => {
	const dir = await createProfileDirectory(path.join(temporaryDirectory(t), 'profile'));
	await prepareProfile(dir);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'headless-profile.json'))), { version: 1, databaseFormat: 'sqlcipher-4', keyFormat: 'raw-256-bit' });
	await prepareProfile(dir);
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('profile checks reject plaintext DBs without altering them', async t => {
	const dir = temporaryDirectory(t);
	const db = path.join(dir, 'database.sqlite');
	const contents = Buffer.from('SQLite format 3\0existing note content');
	fs.writeFileSync(db, contents);
	await assert.rejects(prepareProfile(dir), /plaintext SQLite/);
	assert.deepEqual(fs.readFileSync(db), contents);
	assert.equal(fs.existsSync(path.join(dir, 'headless-profile.json')), false);
});

test('profile checks reject unknown encrypted formats, nested profiles, flags and legacy tokens', async t => {
	for (const [filename, data] of [
		['database.sqlite', 'unknown cipher'],
		['headless-profile.json', JSON.stringify({ version: 999 })],
		['profiles.json', JSON.stringify({ currentProfileId: 'bob', profiles: [{ id: 'bob' }] })],
		['flags.txt', '--log-level debug'],
		['settings.json', JSON.stringify({ 'api.token': 'sensitive-token' })],
	]) {
		const dir = temporaryDirectory(t);
		fs.writeFileSync(path.join(dir, filename), data);
		await assert.rejects(prepareProfile(dir));
		assert.equal(fs.readFileSync(path.join(dir, filename), 'utf8'), data);
	}
});

test('ordinary settings and public resource files remain permitted plaintext', async t => {
	const dir = temporaryDirectory(t);
	fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ 'api.port': 41190 }));
	fs.mkdirSync(path.join(dir, 'resources'));
	fs.writeFileSync(path.join(dir, 'resources', 'public.txt'), 'public reference');
	await prepareProfile(dir);
	assert.equal(fs.readFileSync(path.join(dir, 'resources', 'public.txt'), 'utf8'), 'public reference');
});


test('headless sync cadence accepts seconds without changing standard sync.interval', t => {
	const env = interval => ({ JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: temporaryDirectory(t), JOPLIN_HEADLESS_SYNC_INTERVAL: interval, JOPLIN_HEADLESS_KEY_FD: `${descriptor(t, 'ab'.repeat(32))}` });
	for (const value of ['0', '-1', '1.5', 'foo', '2147484', '']) {
		const values = env(value);
		assert.throws(() => readHeadlessConfig(values), /JOPLIN_HEADLESS_SYNC_INTERVAL/);
		fs.closeSync(Number(values.JOPLIN_HEADLESS_KEY_FD));
	}
	assert.equal(readHeadlessConfig(env('30')).syncIntervalSeconds, 30);
});
