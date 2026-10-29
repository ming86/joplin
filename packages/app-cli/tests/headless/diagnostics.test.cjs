const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const load = require('./loadSource.cjs');

/** Resolve Logger's actual dependencies from its workspace rather than from the isolated test loader. */
function loadLogger() {
	const requireUtils = createRequire(path.resolve(__dirname, '../../../utils/Logger.ts'));
	return load('packages/utils/Logger.ts', Object.fromEntries(
		['moment', 'async-mutex', 'sprintf-js'].map(name => [name, requireUtils(name)]),
	));
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
