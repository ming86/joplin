import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from '../errors.mjs';

/** Default time an exported note remains readable through its resource URI. */
const defaultLifetimeMs = 15 * 60 * 1000;
/** Maximum title portion of a generated filename, leaving room for its id and extension. */
const maxTitleLength = 100;

/** Normalize a note title into a readable filename component without path separators. */
function safeTitle(value) {
	if (typeof value !== 'string') return 'note';
	const title = value.normalize('NFKC')
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.replace(/[. ]+$/g, '');
	const truncated = Array.from(title).slice(0, maxTitleLength).join('').trim();
	return truncated || 'note';
}

/** Create an in-memory store for immutable, short-lived exports of native note snapshots. */
export function createNoteFileResources({ now = Date.now, lifetimeMs = defaultLifetimeMs } = {}) {
	if (typeof now !== 'function') throw new Error('invalid_note_file_clock');
	if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) throw new Error('invalid_note_file_lifetime');

	/** Exported bytes and metadata keyed by their opaque resource URI. */
	const entries = new Map();
	/** One timer serves the earliest expiry, regardless of how many files are stored. */
	let cleanupTimer;
	/** Once closed, the store releases every exported byte and refuses new exports. */
	let closed = false;

	/** Read the injected clock and reject values that cannot form a valid expiry date. */
	function currentTime() {
		const value = now();
		if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) throw new Error('invalid_note_file_clock');
		return value;
	}

	/** Remove expired snapshots using the caller's clock value. */
	function pruneExpired(time) {
		for (const [uri, entry] of entries) {
			if (entry.expiresAt <= time) entries.delete(uri);
		}
	}

	/** Schedule one unreferenced cleanup for the earliest remaining expiry. */
	function scheduleCleanup(time) {
		if (cleanupTimer) clearTimeout(cleanupTimer);
		cleanupTimer = undefined;
		if (closed || entries.size === 0) return;

		let earliestExpiry = Infinity;
		for (const entry of entries.values()) earliestExpiry = Math.min(earliestExpiry, entry.expiresAt);
		const delay = Math.max(1, Math.min(earliestExpiry - time, 2_147_483_647));
		cleanupTimer = setTimeout(() => {
			cleanupTimer = undefined;
			const timeNow = currentTime();
			pruneExpired(timeNow);
			scheduleCleanup(timeNow);
		}, delay);
		cleanupTimer.unref?.();
	}

	/** Build the public, metadata-only listing descriptor for one stored file. */
	function descriptor(entry) {
		return { name: entry.filename, mimeType: entry.mimeType, size: entry.size, uri: entry.uri };
	}

	/** Return one resource block from stored bytes without exposing the internal buffer. */
	function resource(entry) {
		return { uri: entry.uri, mimeType: entry.mimeType, blob: entry.bytes.toString('base64') };
	}

	return Object.freeze({
		/**
		 * Store a rich native note snapshot as immutable UTF-8 bytes.
		 * @param {{id: string, title?: string, body: string, revision_id: string, markup_language?: number}} note Native note fields captured with one revision.
		 * @returns {{file: {uri: string, filename: string, mime_type: string, size: number, sha256: string, expires_at: string}, resource: {uri: string, mimeType: string, blob: string}}} Download metadata and its embedded MCP resource.
		 */
		exportNote(note) {
			if (closed) throw new ServiceError('note_file_unavailable');
			if (!note || typeof note !== 'object' || Array.isArray(note) || typeof note.id !== 'string'
				|| !/^[a-f0-9]{32}$/.test(note.id)
				|| typeof note.body !== 'string' || typeof note.revision_id !== 'string' || !note.revision_id) {
				throw new ServiceError('invalid_note_input');
			}

			const time = currentTime();
			pruneExpired(time);
			const filename = `${safeTitle(note.title)}-${note.id.slice(-8)}.${note.markup_language === 2 ? 'html' : 'md'}`;
			const mimeType = note.markup_language === 2 ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
			const bytes = Buffer.from(note.body, 'utf8');
			const expiresAt = time + lifetimeMs;
			if (!Number.isFinite(expiresAt) || Math.abs(expiresAt) > 8.64e15) throw new Error('invalid_note_file_lifetime');
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			let uri;
			do { uri = `joplin-note-file://${randomUUID()}/${encodeURIComponent(filename)}`; } while (entries.has(uri));
			const entry = Object.freeze({ uri, filename, mimeType, bytes, size: bytes.length, sha256, expiresAt });
			entries.set(uri, entry);
			scheduleCleanup(time);

			return {
				file: {
					uri,
					filename,
					mime_type: mimeType,
					size: entry.size,
					sha256,
					expires_at: new Date(expiresAt).toISOString(),
				},
				resource: resource(entry),
			};
		},

		/**
		 * Read one active export using its exact opaque URI.
		 * @param {string} uri Resource URI returned by exportNote.
		 * @returns {{contents: Array<{uri: string, mimeType: string, blob: string}>}} MCP resource-read result.
		 * @throws {ServiceError} note_file_unavailable when the URI is unknown, expired, or closed.
		 */
		read(uri) {
			if (closed || typeof uri !== 'string') throw new ServiceError('note_file_unavailable');
			const time = currentTime();
			pruneExpired(time);
			const entry = entries.get(uri);
			scheduleCleanup(time);
			if (!entry) throw new ServiceError('note_file_unavailable');
			return { contents: [resource(entry)] };
		},

		/**
		 * List active files without including their bytes.
		 * @returns {Array<{name: string, mimeType: string, size: number, uri: string}>} Active resource descriptors.
		 */
		list() {
			if (closed) return [];
			const time = currentTime();
			pruneExpired(time);
			scheduleCleanup(time);
			return [...entries.values()].map(descriptor);
		},

		/** Release all stored bytes and stop the shared expiry timer. */
		close() {
			if (cleanupTimer) clearTimeout(cleanupTimer);
			cleanupTimer = undefined;
			entries.clear();
			closed = true;
		},
	});
}
