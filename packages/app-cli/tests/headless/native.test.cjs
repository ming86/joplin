const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const load = require('./loadSource.cjs');
const { initializeSqlCipher } = load('packages/app-cli/app/headless/sqlCipher.ts');
const sqliteModule = process.env.JOPLIN_TEST_SQLITE_MODULE;

test('native SQLCipher 4: encrypted FTS4, WAL, reopen, wrong/no key and protected backup restore', {
	skip: sqliteModule ? false : 'Set JOPLIN_TEST_SQLITE_MODULE to a SQLCipher-enabled node-sqlite3 binding; this gate is mandatory before Phase 1 acceptance.',
}, async t => {
	const requireFromCli = createRequire(path.resolve(__dirname, '../../package.json'));
	const sqlite = requireFromCli(sqliteModule).verbose();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-cipher-native-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const filename = path.join(dir, 'database.sqlite');
	const key = require('node:crypto').randomBytes(32);
	t.after(() => key.fill(0));

	const open = async file => {
		let db;
		await new Promise((resolve, reject) => {
			db = new sqlite.Database(file, error => error ? reject(error) : resolve());
		});
		return {
			exec: sql => new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve())),
			selectOne: sql => new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row))),
			close: () => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())),
		};
	};
	const withDb = async (file, operation) => {
		const db = await open(file);
		try { return await operation(db); } finally { await db.close(); }
	};
	const marker = 'headlessencryptedcanary';
	await withDb(filename, async db => {
		assert.match(await initializeSqlCipher(db, key), /^4\./);
		await db.exec('PRAGMA journal_mode = WAL');
		await db.exec('CREATE VIRTUAL TABLE notes_fts USING fts4(title, body)');
		await db.exec(`INSERT INTO notes_fts(title, body) VALUES ('Test', '${marker} search phrase')`);
		assert.equal((await db.selectOne(`SELECT count(*) AS count FROM notes_fts WHERE notes_fts MATCH '${marker}'`)).count, 1);
		for (const name of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, name)).includes(Buffer.from(marker)), `Canary exposed in ${name}`);
	});
	assert.notEqual(fs.readFileSync(filename).subarray(0, 16).toString(), 'SQLite format 3\0');
	await withDb(filename, async db => {
		await initializeSqlCipher(db, key);
		assert.equal((await db.selectOne('SELECT count(*) AS count FROM notes_fts')).count, 1);
	});
	await withDb(filename, db => assert.rejects(initializeSqlCipher(db, Buffer.alloc(32, 0xbb))));
	await withDb(filename, db => assert.rejects(db.selectOne('SELECT count(*) AS count FROM sqlite_master')));
	const backup = path.join(dir, 'backup.sqlite');
	fs.copyFileSync(filename, backup);
	await withDb(backup, async db => {
		await initializeSqlCipher(db, key);
		assert.equal((await db.selectOne(`SELECT count(*) AS count FROM notes_fts WHERE notes_fts MATCH '${marker}'`)).count, 1);
	});
});
