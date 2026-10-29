import { appendFile, chmod, open, rename, rm } from 'fs/promises';
import { join } from 'path';
import Logger, { TargetType } from '@joplin/utils/Logger';

/** Fixed explanations for codes emitted by Joplin, Node networking, and SQLite. */
const explanations: Record<string, string> = {
	invalidOrigin: 'The server rejected the request origin. Check the server public URL and the configured Host header.',
	failSafe: 'Synchronization stopped to prevent data loss because the sync target is empty or damaged.',
	noActiveMasterKey: 'Encryption cannot proceed because no active master key is loaded.',
	masterKeyNotLoaded: 'Decryption requires a master key that is not loaded.',
	lockError: 'Synchronization could not acquire or maintain its target lock.',
	outdatedSyncTarget: 'The sync target format requires an upgrade before synchronization can continue.',
	mustUpgradeApp: 'The server requires a newer Joplin client.',
	rejectedByTarget: 'The sync target rejected an item. Review the target account limits and item requirements before retrying.',
	malformedItem: 'An item could not be read because its stored format is invalid.',
	EADDRINUSE: 'The requested local listening address is already in use.',
	EACCES: 'The operating system denied access to a required file or address.',
	EPERM: 'The operating system denied a required operation.',
	ENOENT: 'A required file or directory could not be found.',
	ELOCKED: 'Another process holds the dedicated profile lease.',
	ECOMPROMISED: 'The dedicated profile lease could not be maintained.',
	MODULE_NOT_FOUND: 'A required runtime module could not be loaded.',
	ECONNREFUSED: 'The remote endpoint refused the connection.',
	ECONNRESET: 'The remote endpoint closed the connection unexpectedly.',
	ENOTFOUND: 'The remote hostname could not be resolved.',
	EAI_AGAIN: 'Hostname resolution failed temporarily.',
	ETIMEDOUT: 'The remote operation timed out.',
	CERT_HAS_EXPIRED: 'The remote TLS certificate has expired.',
	DEPTH_ZERO_SELF_SIGNED_CERT: 'The remote TLS certificate is self-signed and is not trusted.',
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The remote TLS certificate chain could not be verified.',
	SQLITE_NOTADB: 'The database could not be read. Check the database key and SQLCipher build.',
	SQLITE_BUSY: 'The database is busy with another operation.',
	SQLITE_CANTOPEN: 'The database file could not be opened.',
};

/** Error names with fixed meaning; arbitrary names can contain upstream payloads. */
const errorTypes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'AggregateError', 'AbortError', 'FetchError', 'JoplinError', 'JoplinApiError']);

/** Known source modules whose locations are useful without revealing absolute paths or function names. */
const stackModules = new Set(['main', 'app', 'status', 'diagnostics', 'config', 'profile', 'sqlCipher', 'DatabaseDriver', 'HeadlessSyncScheduler', 'runService', 'command-sync', 'command-e2ee', 'JoplinServerApi', 'Synchronizer', 'DecryptionWorker', 'EncryptionService', 'database', 'database-driver-node', 'file-api-driver-joplinServer', 'registry']);

/** The independent logger accepts only values selected by this module, never original errors. */
let diagnosticLogger: Logger | null = null;

/** Rotate before the next complete record would make a nonempty file exceed 10 MiB. */
const maxLogBytes = 10 * 1024 * 1024;

/** Filesystem failure codes that identify an actionable cause without revealing private error data. */
const fileErrorCodes = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'EISDIR', 'ENOTDIR']);

/** Get a stderr logger even before the profile and application have initialized. */
function logger(): Logger {
	if (!diagnosticLogger) {
		diagnosticLogger = new Logger();
		const stderr = (...values: unknown[]) => console.error(...values);
		diagnosticLogger.addTarget(TargetType.Console, { console: { info: stderr, warn: stderr, error: stderr } as Console });
	}
	return diagnosticLogger;
}

/** Open a private diagnostic file and retain three size-bounded archives in the dedicated profile. */
export async function initializeHeadlessDiagnostics(profileDir: string): Promise<void> {
	const path = join(profileDir, 'log-headless.txt');
	const archives = [1, 2, 3].map(index => join(profileDir, `log-headless.${index}.txt`));
	const file = await open(path, 'a', 0o600);
	/** Cached active-file bytes; the headless writer exclusively owns this diagnostic file. */
	let size: number;
	try {
		await file.chmod(0o600);
		size = (await file.stat()).size;
	} finally {
		await file.close();
	}
	for (const archive of archives) {
		try {
			await chmod(archive, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	logger().addTarget(TargetType.File, {
		path,
		fsDriver: {
			// Logger holds its write mutex throughout rotation and append, including queued records.
			appendFile: async (_path, content) => {
				try {
					const bytes = Buffer.byteLength(content, 'utf8');
					if (size > 0 && size + bytes > maxLogBytes) {
						await rm(archives[2], { force: true });
						for (let index = archives.length - 1; index > 0; index--) {
							try {
								await rename(archives[index - 1], archives[index]);
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
							}
						}
						await rename(path, archives[0]);
						size = 0;
					}
					// A single oversized record stays intact; the following record rotates it.
					await appendFile(path, content, { encoding: 'utf8', mode: 0o600 });
					size += bytes;
				} catch (error) {
					// Logger prints this failure directly, so exclude filesystem paths and raw error details.
					const safeError: NodeJS.ErrnoException = new Error('Headless diagnostic log rotation or append failed.');
					const code = (error as NodeJS.ErrnoException).code;
					if (code && fileErrorCodes.has(code)) safeError.code = code;
					throw safeError;
				}
			},
		},
	});
}

/** Read a valid HTTP status without forwarding arbitrary numeric error codes. */
function httpStatus(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** Keep only known module locations, excluding the stack message, functions, and full paths. */
function callSites(stack: unknown): string[] {
	if (typeof stack !== 'string') return [];
	const output: string[] = [];
	for (const line of stack.split('\n')) {
		const location = /^\s+at .*[\\/]([\w-]+)\.(?:js|ts):(\d+):(\d+)\)?$/.exec(line);
		if (location && stackModules.has(location[1])) output.push(`${location[1]}:${location[2]}:${location[3]}`);
		if (output.length === 8) break;
	}
	return output;
}

/** Select safe metadata from one external error; raw messages and properties never reach Logger. */
function summarizeError(value: unknown) {
	const error = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const type = typeof error.name === 'string' && errorTypes.has(error.name) ? error.name : 'UnknownError';
	const code = typeof error.code === 'string' && Object.prototype.hasOwnProperty.call(explanations, error.code) ? error.code : undefined;
	const status = httpStatus(error.httpCode) ?? httpStatus(error.status) ?? httpStatus(error.code);
	let explanation = code ? explanations[code] : undefined;
	// These exact messages are emitted by Joplin Server; substitute fixed prose, never copy their contents.
	if (!explanation && (error.message === 'Invalid email or password' || error.message === 'Invalid password or authentication code')) {
		explanation = 'The server rejected the account credentials or authentication code.';
	}
	if (!explanation && typeof error.message === 'string' && error.message.startsWith('Invalid origin: ')) explanation = explanations.invalidOrigin;
	if (!explanation && error.message === 'Synchronisation authentication was not completed.') {
		explanation = 'Synchronization could not authenticate. Check the configured account credentials and complete authentication before retrying.';
	}
	if (!explanation && typeof error.message === 'string' && /^Decryption skipped \d+ items disabled after repeated failures\. Use --retry-failed-items to retry them\.$/.test(error.message)) {
		explanation = 'Decryption skipped items disabled after repeated failures. Retry the failed items with e2ee decrypt --retry-failed-items.';
	}
	if (!explanation && error.message === 'Encrypted database initialization failed: SQLCipher 4 is required and the key must match. No plaintext fallback or automatic migration was attempted.') {
		explanation = 'Encrypted database initialization failed. SQLCipher 4 is required and the database key must match.';
	}
	if (!explanation && (status === 401 || status === 403)) explanation = 'The server rejected authentication or permission for this operation.';
	if (!explanation && status === 429) explanation = 'The server rate-limited the operation.';
	if (!explanation && status && status >= 500) explanation = 'The remote server could not complete the operation.';
	return {
		type, code, httpStatus: status,
		explanation: explanation ?? 'No vetted explanation is available. Upstream messages are omitted because they may contain private data.',
		callSites: callSites(error.stack),
	};
}

/** Log a boundary failure and its cause chain. Action and stage must be fixed internal strings. */
export function logHeadlessError(action: string, stage: string, error: unknown): void {
	const errors: ReturnType<typeof summarizeError>[] = [];
	const seen = new Set<unknown>();
	let current = error;
	while (current !== undefined && !seen.has(current) && errors.length < 8) {
		seen.add(current);
		errors.push(summarizeError(current));
		current = current && typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
	}
	// A JSON string also keeps the console target from inspecting any object with custom serializers.
	logger().error(JSON.stringify({ action, stage, errors, causeChainTruncated: current !== undefined }));
}

/** Log a lifecycle transition. Action and stage must be fixed internal strings. */
export function logHeadlessInfo(action: string, stage: string): void {
	logger().info(JSON.stringify({ action, stage }));
}

/** Drain Logger's queued file writes before a headless caller explicitly exits. */
export async function flushHeadlessDiagnostics(): Promise<void> {
	if (diagnosticLogger) await diagnosticLogger.waitForFileWritesToComplete_();
}
