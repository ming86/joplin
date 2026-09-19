import { mkdir, readFile, realpath, open, access, writeFile } from 'fs/promises';
import { join } from 'path';

const markerName = 'headless-profile.json';
const marker = { version: 1, databaseFormat: 'sqlcipher-4', keyFormat: 'raw-256-bit' };

const exists = async (path: string) => {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
};

export const createProfileDirectory = async (profileDir: string) => {
	await mkdir(profileDir, { recursive: true, mode: 0o700 });
	return realpath(profileDir);
};

// Call only while holding the exclusive profile lease, before Joplin touches the profile.
export const prepareProfile = async (profileDir: string) => {
	if (await exists(join(profileDir, 'flags.txt'))) {
		throw new Error('A headless profile must not contain flags.txt overrides.');
	}
	if (await exists(join(profileDir, 'profiles.json'))) {
		const config = JSON.parse(await readFile(join(profileDir, 'profiles.json'), 'utf8'));
		if (config.currentProfileId !== 'default' || config.profiles?.length !== 1 || config.profiles[0]?.id !== 'default') {
			throw new Error('Use one independent root profile per account, not nested Joplin profiles.');
		}
	}
	if (await exists(join(profileDir, 'settings.json'))) {
		const settings = JSON.parse(await readFile(join(profileDir, 'settings.json'), 'utf8'));
		if (settings['api.token']) throw new Error('A plaintext legacy API token was found. Use a fresh headless profile; in-place migration is not supported.');
	}
	const databasePath = join(profileDir, 'database.sqlite');
	const hasDatabase = await exists(databasePath);
	if (hasDatabase) {
		const file = await open(databasePath, 'r');
		try {
			const header = Buffer.alloc(16);
			await file.read(header, 0, header.length, 0);
			if (header.toString('utf8') === 'SQLite format 3\0') {
				throw new Error('Refusing a plaintext SQLite profile. Start with a fresh encrypted profile and synchronize it.');
			}
		} finally {
			await file.close();
		}
	}
	const markerPath = join(profileDir, markerName);
	if (await exists(markerPath)) {
		const existing = JSON.parse(await readFile(markerPath, 'utf8'));
		if (existing.version !== marker.version || existing.databaseFormat !== marker.databaseFormat || existing.keyFormat !== marker.keyFormat) {
			throw new Error('Unsupported headless profile format.');
		}
	} else {
		if (hasDatabase) throw new Error('An existing database without a headless format marker cannot be adopted automatically.');
		await writeFile(markerPath, `${JSON.stringify(marker, null, '\t')}\n`, { flag: 'wx', mode: 0o600 });
	}
};
