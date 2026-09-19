import { closeSync, readSync } from 'fs';
import { isAbsolute, parse, resolve } from 'path';

export interface HeadlessConfig {
	profileDir: string;
	databaseKey: Buffer;
	sqliteModule: string;
}

export const readDatabaseKey = (fd: number) => {
	if (!Number.isSafeInteger(fd) || fd < 3) throw new Error('The database key must be supplied on an inherited file descriptor >= 3.');
	const input = Buffer.alloc(128);
	try {
		let length = 0;
		while (length < input.length) {
			const read = readSync(fd, input, length, input.length - length, null);
			if (!read) break;
			length += read;
		}
		const text = input.subarray(0, length).toString('utf8');
		if (!/^[a-fA-F0-9]{64}(?:\r?\n)?$/.test(text)) throw new Error('Invalid key format');
		return Buffer.from(text.trim(), 'hex');
	} catch (_error) {
		// Native errors can contain input or file names; bootstrap errors must not.
		throw new Error('Cannot read the database key: provide exactly 64 hexadecimal characters and EOF on the inherited descriptor.');
	} finally {
		input.fill(0);
		try {
			closeSync(fd);
		} catch (_error) {
			// The descriptor may already be invalid.
		}
	}
};

export const readHeadlessConfig = (env: NodeJS.ProcessEnv): HeadlessConfig | null => {
	if (env.JOPLIN_HEADLESS === undefined) return null;
	if (env.JOPLIN_HEADLESS !== '1') throw new Error('JOPLIN_HEADLESS must be 1, or unset for the standard CLI.');
	const profileDir = env.JOPLIN_HEADLESS_PROFILE;
	if (!profileDir || !isAbsolute(profileDir) || resolve(profileDir) === parse(profileDir).root) {
		throw new Error('JOPLIN_HEADLESS_PROFILE must be an absolute, dedicated profile directory, not a filesystem root.');
	}
	const sqliteModule = env.JOPLIN_HEADLESS_SQLITE_MODULE || 'sqlite3';
	if (sqliteModule !== 'sqlite3' && !isAbsolute(sqliteModule)) {
		throw new Error('JOPLIN_HEADLESS_SQLITE_MODULE must be an absolute module path, or unset to use the installed sqlite3 binding.');
	}
	const descriptor = env.JOPLIN_HEADLESS_KEY_FD;
	if (!descriptor || !/^\d+$/.test(descriptor) || Number(descriptor) < 3) {
		throw new Error('JOPLIN_HEADLESS_KEY_FD must identify an inherited descriptor >= 3. Never put the key in an argument or environment variable.');
	}
	delete env.JOPLIN_HEADLESS_KEY_FD;
	return { profileDir: resolve(profileDir), databaseKey: readDatabaseKey(Number(descriptor)), sqliteModule };
};

export const headlessArgv = (argv: string[], config: Pick<HeadlessConfig, 'profileDir'>) => {
	const command = argv.slice(2);
	if (!command.length) command.push('serve');
	if (command[0].startsWith('-') || command[0] === 'server') {
		throw new Error('Use a command (serve, config, sync, e2ee, ...) without global flags in headless mode. Profile and logging are controlled by the launcher.');
	}
	return [...argv.slice(0, 2), '--profile', config.profileDir, '--no-welcome', '--log-level', 'none', ...command];
};
