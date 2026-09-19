const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadSource.cjs');
const { initializeSqlCipher } = load('packages/app-cli/app/headless/sqlCipher.ts');

function connection(options = {}) {
	const calls = [];
	return {
		calls,
		exec: async sql => {
			calls.push(sql);
			if (options.failExec) throw new Error(sql);
		},
		selectOne: async sql => {
			calls.push(sql);
			if (sql === 'PRAGMA cipher_version') return options.noCipher ? undefined : { cipher_version: options.version || '4.14.0 test-double' };
			if (sql === 'PRAGMA temp_store') return { temp_store: options.tempStore ?? 2 };
			if (options.wrongKey) throw new Error(`SQLITE_NOTADB ${calls[0]}`);
			return { count: 2 };
		},
	};
}

test('key and format precede schema access; positive library detection and memory temp storage are mandatory', async () => {
	const db = connection();
	const key = Buffer.alloc(32, 0xaa);
	assert.match(await initializeSqlCipher(db, key), /^4\./);
	assert.equal(db.calls[0], `PRAGMA key = "x'${'aa'.repeat(32)}'"`);
	assert.ok(db.calls.indexOf('PRAGMA cipher_version') < db.calls.findIndex(sql => sql.startsWith('SELECT')));
	assert.ok(db.calls.includes('PRAGMA cipher_plaintext_header_size = 0'));
	assert.ok(db.calls.includes('PRAGMA cipher_use_hmac = ON'));
	assert.ok(db.calls.includes('PRAGMA temp_store = MEMORY'));
});

test('unsupported builds, wrong keys and native failures fail closed without the secret', async () => {
	for (const failure of [{ noCipher: true }, { version: '3.4' }, { wrongKey: true }, { failExec: true }, { tempStore: 1 }]) {
		await assert.rejects(initializeSqlCipher(connection(failure), Buffer.alloc(32, 0xab)), error => {
			assert.match(error.message, /No plaintext fallback/);
			assert.ok(!error.message.includes('ab'.repeat(32)));
			assert.ok(!error.message.includes('PRAGMA'));
			return true;
		});
	}
});

test('invalid key length is rejected before any database call', async () => {
	const db = connection();
	await assert.rejects(initializeSqlCipher(db, Buffer.alloc(0)), /32-byte/);
	assert.equal(db.calls.length, 0);
});

test('a real ordinary SQLite engine ignores cipher pragmas but is rejected by the positive check', async () => {
	const { DatabaseSync } = require('node:sqlite');
	const db = new DatabaseSync(':memory:');
	try {
		await assert.rejects(initializeSqlCipher({
			exec: async sql => { db.exec(sql); },
			selectOne: async sql => db.prepare(sql).get(),
		}, Buffer.alloc(32, 0x11)), /SQLCipher 4 is required/);
		assert.equal(db.prepare('SELECT count(*) AS count FROM sqlite_master').get().count, 0);
	} finally {
		db.close();
	}
});

test('driver waits for key verification, closes on failure and wipes the supplied key', async () => {
	for (const wrongKey of [false, true]) {
		let closed = false;
		const fake = connection({ wrongKey });
		class Driver {
			async open() {}
			async close() { closed = true; }
			exec(sql) { return fake.exec(sql); }
			selectOne(sql) { return fake.selectOne(sql); }
		}
		const { default: EncryptedDriver } = load('packages/app-cli/app/headless/DatabaseDriver.ts', {
			'@joplin/lib/database-driver-node': { DatabaseDriverNode: Driver },
			'./sqlCipher': { initializeSqlCipher },
		});
		const key = Buffer.alloc(32, 0xab);
		const driver = new EncryptedDriver(key);
		if (wrongKey) await assert.rejects(driver.open({ name: 'database.sqlite' }));
		else await driver.open({ name: 'database.sqlite' });
		assert.equal(closed, wrongKey);
		assert.deepEqual(key, Buffer.alloc(32));
	}
});
