export interface SqlCipherConnection {
	/** Executes a statement; initialization does not consume driver execution metadata. */
	exec(sql: string): Promise<unknown>;
	selectOne(sql: string): Promise<unknown>;
}

export const initializeSqlCipher = async (connection: SqlCipherConnection, key: Buffer) => {
	if (key.length !== 32) throw new Error('A 32-byte database key is required.');
	try {
		// Keep this below Joplin's SQL logger. Only a validated raw key enters this statement.
		await connection.exec(`PRAGMA key = "x'${key.toString('hex')}'"`);
		await connection.exec('PRAGMA cipher_compatibility = 4');
		const version = await connection.selectOne('PRAGMA cipher_version') as { cipher_version?: unknown } | undefined;
		if (typeof version?.cipher_version !== 'string' || !/^4\./.test(version.cipher_version)) {
			throw new Error('Unsupported cipher');
		}
		await connection.exec('PRAGMA cipher_plaintext_header_size = 0');
		await connection.exec('PRAGMA cipher_use_hmac = ON');
		await connection.exec('PRAGMA temp_store = MEMORY');
		const tempStore = await connection.selectOne('PRAGMA temp_store') as { temp_store?: unknown } | undefined;
		if (tempStore?.temp_store !== 2) throw new Error('Temporary storage must be in memory');
		// A successful key PRAGMA alone neither proves encryption nor validates an existing key.
		const schema = await connection.selectOne('SELECT count(*) AS count FROM sqlite_master') as { count?: unknown } | undefined;
		if (typeof schema?.count !== 'number') throw new Error('Schema unreadable');
		return version.cipher_version;
	} catch (_error) {
		throw new Error('Encrypted database initialization failed: SQLCipher 4 is required and the key must match. No plaintext fallback or automatic migration was attempted.');
	}
};
