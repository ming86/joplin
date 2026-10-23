import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ServiceError } from '../errors.mjs';

/** Return whether an IPv4 address is outside local, private, and reserved ranges. */
function publicIpv4(address) {
	const [a, b, c] = address.split('.').map(Number);
	return a !== 0 && a !== 10 && a !== 127 && a < 224
		&& !(a === 100 && b >= 64 && b <= 127)
		&& !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
		&& !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
		&& !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
		&& !(a === 203 && b === 0 && c === 113);
}

/** Accept global IPv6 unicast, excluding special-purpose and documentation allocations. */
function publicIpv6(address) {
	// Embedded IPv4 and zone identifiers cannot provide a separate route around IPv4 checks.
	if (address.includes('.') || address.includes('%')) return false;
	const [left, right] = address.toLowerCase().split('::');
	const start = left ? left.split(':') : [];
	const end = right ? right.split(':') : [];
	const groups = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
	const [a, b] = groups.map(part => Number.parseInt(part, 16));
	return a >= 0x2000 && a <= 0x3fff
		&& !(a === 0x2001 && b < 0x200) // IETF special-purpose addresses (including transition mechanisms).
		&& !(a === 0x2001 && b === 0xdb8)
		&& a !== 0x2002 // 6to4 embeds an IPv4 destination.
		&& !(a === 0x3fff && b < 0x1000);
}

/** Require a globally routable destination, including when DNS supplies an IP literal. */
function requirePublicAddress(address) {
	const family = isIP(address);
	if (!(family === 4 ? publicIpv4(address) : family === 6 && publicIpv6(address))) {
		throw new ServiceError('note_file_unsafe_url');
	}
}

/** Validate the client file reference without including its signed URL in errors. */
function fileUrl(file) {
	if (!file || typeof file !== 'object' || Array.isArray(file)
		|| typeof file.download_url !== 'string' || typeof file.file_id !== 'string' || !file.file_id
		|| (file.mime_type !== undefined && typeof file.mime_type !== 'string')
		|| (file.file_name !== undefined && typeof file.file_name !== 'string')) throw new ServiceError('invalid_note_file_input');
	let url;
	try { url = new URL(file.download_url); } catch { throw new ServiceError('note_file_invalid_url'); }
	if (url.protocol !== 'https:' || url.username || url.password) throw new ServiceError('note_file_invalid_url');
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (isIP(host)) requirePublicAddress(host);
	return url;
}

/**
 * Create the shared HTTPS downloader with injectable Node transports for focused tests.
 * DNS results are validated and pinned to the connection; requests do not follow redirects.
 * Codex and ChatGPT adapt local paths to downloadable references; this service fetches those
 * references and never opens paths on the client's machine. Exact-byte findings are in
 * chatgpt-work/DESKTOP-MCP-PARITY-HANDOFF.md.
 */
function createFileDownloader({ lookup = dnsLookup, request = httpsRequest } = {}) {
	/** Resolve all addresses once and pin the connection to that validated result. */
	function publicLookup(hostname, options, callback) {
		lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
			if (error) { callback(new ServiceError('note_file_download_failed')); return; }
			try {
				if (!addresses?.length) throw new ServiceError('note_file_download_failed');
				for (const entry of addresses) requirePublicAddress(entry.address);
				if (options.all) callback(null, addresses);
				else callback(null, addresses[0].address, addresses[0].family);
			} catch (failure) { callback(failure); }
		});
	}

	/** Download a complete file as bytes without decoding or altering its contents. */
	return async function downloadFile(file, signal) {
		const url = fileUrl(file);
		if (signal?.aborted) throw new ServiceError('request_cancelled');
		const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
		let req;
		let response;
		try {
			response = await new Promise((resolve, reject) => {
				req = request(url, { lookup: publicLookup, agent: false, signal: combined, headers: { 'Accept-Encoding': 'identity' } }, resolve);
				req.once('error', reject);
				req.end();
			});
			if (response.statusCode < 200 || response.statusCode >= 300) throw new ServiceError('note_file_download_failed');
			const parts = [];
			for await (const chunk of response) parts.push(Buffer.from(chunk));
			return Buffer.concat(parts);
		} catch (error) {
			if (signal?.aborted) throw new ServiceError('request_cancelled');
			if (error instanceof ServiceError) throw error;
			throw new ServiceError('note_file_download_failed');
		} finally {
			response?.destroy();
			req?.destroy();
		}
	};
}

/**
 * Create a client file reader that returns exact bytes, including data that is not valid UTF-8.
 * Optional lookup and request functions override the Node transports for focused tests.
 */
export function createBinaryFileReader(options = {}) {
	return createFileDownloader(options);
}

/** Read an HTTPS client file reference as a Buffer; failures precede any save. */
export const readBinaryFile = createBinaryFileReader();

/**
 * Create a strict UTF-8 note-body reader, retain its BOM, and reject malformed text.
 * Optional lookup and request functions override the Node transports for focused tests.
 */
export function createNoteBodyFileReader(options = {}) {
	const downloadFile = createFileDownloader(options);
	return async function readNoteBodyFile(file, signal) {
		const bytes = await downloadFile(file, signal);
		try {
			return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			throw new ServiceError('note_file_invalid_utf8');
		}
	};
}

/** Read an HTTPS client file reference as the exact note body; failures precede any save. */
export const readNoteBodyFile = createNoteBodyFileReader();
