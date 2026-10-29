const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { inspect } = require('node:util');
const load = require('./loadSource.cjs');

/** Resolve Logger's actual dependencies from its workspace rather than from the isolated test loader. */
function loadLogger() {
	const requireUtils = createRequire(path.resolve(__dirname, '../../../utils/Logger.ts'));
	return load('packages/utils/Logger.ts', Object.fromEntries(
		['moment', 'async-mutex', 'sprintf-js'].map(name => [name, requireUtils(name)]),
	));
}

/** Use the production threshold so tests exercise the deployed retention policy. */
const maxLogBytes = 10 * 1024 * 1024;

/** Read complete real-Logger records after their timestamp prefix. */
function readRecords(filename) {
	return fs.readFileSync(filename, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line.slice(line.indexOf('{'))));
}

test('real Logger file and stderr targets receive vetted metadata without error payloads', async t => {
	const LoggerModule = loadLogger();
	const Logger = LoggerModule.default;
	Logger.fsDriver_ = { appendFile: fs.promises.appendFile };
	const diagnostics = load('packages/app-cli/app/headless/diagnostics.ts', { '@joplin/utils/Logger': LoggerModule });
	const stderr = [];
	t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-headless-diagnostics-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const logPath = path.join(dir, 'log-headless.txt');
	fs.writeFileSync(logPath, '', { mode: 0o644 });
	const secret = 'private-token-note-body';
	const cause = Object.assign(new Error(`Invalid origin: https://${secret}.invalid\n${secret}`), {
		code: 'invalidOrigin', httpCode: 404,
		headers: { 'X-API-AUTH': secret }, request: `POST ${secret}`, response: { body: secret }, details: secret,
	});
	cause.stack = `Error: ${secret}\n    at ${secret} (/app/packages/lib/JoplinServerApi.js:291:12)\n    at ${secret} (https://${secret}.invalid/app.js?token=${secret}:8:9)\n    at ${secret} (/private/${secret}.js:4:5)`;
	const error = Object.assign(new Error(`HTTP response\n<html>${secret}</html>`), {
		code: secret, cause, headers: { Authorization: secret }, request: secret,
		toJSON() { throw new Error('Original error must never be serialized'); },
	});

	// Pre-profile failures still have useful stderr diagnostics.
	diagnostics.logHeadlessError('bootstrap', 'load-dependencies', error);
	await diagnostics.initializeHeadlessDiagnostics(dir);
	diagnostics.logHeadlessInfo('startup', 'starting');
	diagnostics.logHeadlessError('status', 'account-profile', error);
	await diagnostics.flushHeadlessDiagnostics();
	assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
	const fileText = fs.readFileSync(logPath, 'utf8');
	for (const output of [fileText, stderr.join('\n')]) {
		assert.ok(!output.includes(secret), output);
		assert.ok(!output.includes('<html>'), output);
		assert.match(output, /"action":"status","stage":"account-profile"/);
		assert.match(output, /"code":"invalidOrigin","httpStatus":404/);
		assert.match(output, /server rejected the request origin/);
		assert.match(output, /JoplinServerApi:291:12/);
		assert.ok(!output.includes('/app/packages/'));
	}
	const record = JSON.parse(stderr.at(-1).slice(stderr.at(-1).indexOf('{')));
	assert.equal(record.errors.length, 2);
	assert.equal(record.errors[0].code, undefined);
	assert.equal(record.causeChainTruncated, false);
});

test('recognized authentication, fail-safe, and network errors receive fixed explanations', async t => {
	const LoggerModule = loadLogger();
	const diagnostics = load('packages/app-cli/app/headless/diagnostics.ts', { '@joplin/utils/Logger': LoggerModule });
	const stderr = [];
	t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')));
	for (const error of [
		Object.assign(new Error('Invalid email or password'), { code: 403 }),
		Object.assign(new Error('private fail-safe payload'), { code: 'failSafe' }),
		Object.assign(new Error('private hostname'), { code: 'ECONNREFUSED' }),
		Object.assign(new Error('Invalid origin: https://private-origin.invalid\nprivate response'), { code: 404 }),
		Object.assign(new Error('private response'), { code: 'invalidOrigin' }),
		new Error('Synchronisation authentication was not completed.'),
		new Error('Decryption skipped 3 items disabled after repeated failures. Use --retry-failed-items to retry them.'),
		Object.assign(new Error('private rejected item'), { code: 'rejectedByTarget' }),
		Object.assign(new Error('private malformed item'), { code: 'malformedItem' }),
	]) diagnostics.logHeadlessError('sync', 'full', error);
	assert.match(stderr[0], /server rejected the account credentials/);
	assert.match(stderr[1], /Synchronization stopped to prevent data loss/);
	assert.match(stderr[2], /remote endpoint refused the connection/);
	assert.match(stderr[3], /"httpStatus":404/);
	assert.match(stderr[3], /server rejected the request origin/);
	assert.match(stderr[4], /"code":"invalidOrigin"/);
	assert.match(stderr[4], /server rejected the request origin/);
	assert.match(stderr[5], /Synchronization could not authenticate/);
	assert.match(stderr[6], /e2ee decrypt --retry-failed-items/);
	assert.match(stderr[7], /sync target rejected an item/);
	assert.match(stderr[8], /stored format is invalid/);
	assert.ok(!stderr.join('\n').includes('private'));
});

test('rotation retains the newest three archives and keeps queued records complete and ordered', async t => {
	const LoggerModule = loadLogger();
	const diagnostics = load('packages/app-cli/app/headless/diagnostics.ts', { '@joplin/utils/Logger': LoggerModule });
	t.mock.method(console, 'error', () => {});
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-headless-rotation-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	await diagnostics.initializeHeadlessDiagnostics(dir);
	const padding = 'x'.repeat(maxLogBytes - 128);
	// Each record fits alone. Queue every write before waiting so each subsequent write must rotate in order.
	for (let index = 1; index <= 5; index++) diagnostics.logHeadlessInfo(`record-${index}`, padding);
	diagnostics.logHeadlessInfo('continuation', 'after-rotation');
	await diagnostics.flushHeadlessDiagnostics();
	assert.deepEqual(fs.readdirSync(dir).sort(), ['log-headless.1.txt', 'log-headless.2.txt', 'log-headless.3.txt', 'log-headless.txt']);
	for (const [filename, actions] of [
		['log-headless.txt', ['record-5', 'continuation']],
		['log-headless.1.txt', ['record-4']],
		['log-headless.2.txt', ['record-3']],
		['log-headless.3.txt', ['record-2']],
	]) {
		const filenamePath = path.join(dir, filename);
		const records = readRecords(filenamePath);
		assert.deepEqual(records.map(record => record.action), actions);
		assert.equal(records[0].stage, padding);
		assert.ok(fs.statSync(filenamePath).size <= maxLogBytes);
		assert.equal(fs.statSync(filenamePath).mode & 0o777, 0o600);
	}
});

test('startup rotates an oversized active file, tightens archive permissions, and preserves retention after restart', async t => {
	const LoggerModule = loadLogger();
	const mocks = { '@joplin/utils/Logger': LoggerModule };
	const diagnostics = load('packages/app-cli/app/headless/diagnostics.ts', mocks);
	t.mock.method(console, 'error', () => {});
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-headless-restart-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const logPath = path.join(dir, 'log-headless.txt');
	fs.writeFileSync(logPath, 'oversized-active\n', { mode: 0o644 });
	fs.truncateSync(logPath, maxLogBytes + 1);
	for (let index = 1; index <= 3; index++) fs.writeFileSync(path.join(dir, `log-headless.${index}.txt`), `archive-${index}\n`, { mode: 0o644 });
	await diagnostics.initializeHeadlessDiagnostics(dir);
	for (const filename of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, filename)).mode & 0o777, 0o600);
	diagnostics.logHeadlessInfo('first', 'after-startup');
	diagnostics.logHeadlessInfo('second', 'queued-after-startup');
	await diagnostics.flushHeadlessDiagnostics();
	assert.equal(fs.statSync(path.join(dir, 'log-headless.1.txt')).size, maxLogBytes + 1);
	assert.ok(fs.readFileSync(path.join(dir, 'log-headless.1.txt'), 'utf8').startsWith('oversized-active\n'));
	assert.equal(fs.readFileSync(path.join(dir, 'log-headless.2.txt'), 'utf8'), 'archive-1\n');
	assert.equal(fs.readFileSync(path.join(dir, 'log-headless.3.txt'), 'utf8'), 'archive-2\n');
	const restarted = load('packages/app-cli/app/headless/diagnostics.ts', mocks);
	await restarted.initializeHeadlessDiagnostics(dir);
	restarted.logHeadlessInfo('third', 'after-restart');
	await restarted.flushHeadlessDiagnostics();
	assert.deepEqual(readRecords(logPath).map(record => record.action), ['first', 'second', 'third']);
	assert.equal(fs.readFileSync(path.join(dir, 'log-headless.2.txt'), 'utf8'), 'archive-1\n');
	assert.equal(fs.readFileSync(path.join(dir, 'log-headless.3.txt'), 'utf8'), 'archive-2\n');
	for (const filename of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, filename)).mode & 0o777, 0o600);
});

test('rotation includes UTF-8 bytes and the next record while allowing an exact-size file', async t => {
	t.mock.method(console, 'error', () => {});
	for (const excessBytes of [0, 1]) {
		const LoggerModule = loadLogger();
		const diagnostics = load('packages/app-cli/app/headless/diagnostics.ts', { '@joplin/utils/Logger': LoggerModule });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-headless-bytes-'));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const logPath = path.join(dir, 'log-headless.txt');
		const action = 'utf8';
		const stage = '🦉测试';
		// Logger adds the 19-byte timestamp, ': ', and a newline to this JSON record.
		const recordBytes = 22 + Buffer.byteLength(JSON.stringify({ action, stage }), 'utf8');
		const initialBytes = maxLogBytes - recordBytes + excessBytes;
		fs.writeFileSync(logPath, 'previous-record\n', { mode: 0o600 });
		fs.truncateSync(logPath, initialBytes);
		await diagnostics.initializeHeadlessDiagnostics(dir);
		diagnostics.logHeadlessInfo(action, stage);
		await diagnostics.flushHeadlessDiagnostics();
		assert.equal(fs.existsSync(path.join(dir, 'log-headless.1.txt')), excessBytes === 1);
		assert.equal(fs.statSync(logPath).size, excessBytes === 1 ? recordBytes : maxLogBytes);
		assert.ok(fs.readFileSync(logPath, 'utf8').endsWith(`${JSON.stringify({ action, stage })}\n`));
	}
});

test('file failures report a fixed diagnostic without underlying filesystem error details', async t => {
	const stderr = [];
	t.mock.method(console, 'error', (...args) => stderr.push(args));
	const secret = 'private-path-error-payload';
	for (const operation of ['rename', 'appendFile']) {
		const LoggerModule = loadLogger();
		const diagnostics = load('packages/app-cli/app/headless/diagnostics.ts', {
			'@joplin/utils/Logger': LoggerModule,
			'fs/promises': { ...fs.promises, [operation]: async () => { throw Object.assign(new Error(secret), { code: operation === 'rename' ? 'EACCES' : secret }); } },
		});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-headless-file-error-'));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		if (operation === 'rename') {
			const logPath = path.join(dir, 'log-headless.txt');
			fs.writeFileSync(logPath, '', { mode: 0o600 });
			fs.truncateSync(logPath, maxLogBytes);
		}
		await diagnostics.initializeHeadlessDiagnostics(dir);
		diagnostics.logHeadlessInfo('failure-test', operation);
		await diagnostics.flushHeadlessDiagnostics();
	}
	const failures = stderr.filter(args => args[0] === 'Cannot write to log file:').map(args => args[1]);
	assert.equal(failures.length, 2);
	assert.ok(failures.every(error => error.message === 'Headless diagnostic log rotation or append failed.'));
	assert.equal(failures[0].code, 'EACCES');
	assert.equal(failures[1].code, undefined);
	assert.ok(!inspect(stderr).includes(secret));
});

test('bootstrap catches module-load failures, wipes the key, and drains diagnostics before exiting', async () => {
	const source = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
	const key = Buffer.alloc(32, 0xab);
	const original = Object.assign(new Error('private bootstrap response'), { code: 'MODULE_NOT_FOUND' });
	const calls = [];
	const exitSignal = new Error('VM process exited');
	const mocks = {
		'compare-version': () => 1,
		'./headless/config': { readHeadlessConfig: () => ({ databaseKey: key }) },
		'./headless/diagnostics': {
			logHeadlessError: (...args) => calls.push(args),
			flushHeadlessDiagnostics: async () => calls.push('flushed'),
		},
		'@joplin/lib/models/Setting': { default: { setConstant() {} } },
	};
	const completion = vm.runInNewContext(source, {
		require: name => { if (Object.hasOwn(mocks, name)) return mocks[name]; throw original; },
		process: { versions: { node: '26.0.0' }, env: {}, exit: code => { calls.push(['exit', code]); throw exitSignal; } },
		console: { error: (...args) => calls.push(['stderr', ...args]) },
	});
	await assert.rejects(completion, error => error === exitSignal);
	assert.deepEqual(calls[0], ['bootstrap', 'load-dependencies', original]);
	assert.deepEqual(calls[1], 'flushed');
	assert.deepEqual(calls.at(-1), ['exit', 1]);
	assert.ok(key.every(value => value === 0));
	assert.ok(!JSON.stringify(calls.filter(call => call[0] === 'stderr')).includes(original.message));
});
