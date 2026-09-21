import fs from 'node:fs';
import path from 'node:path';
import { requireValue, ServiceError } from '../errors.mjs';

export function absolute(value) {
	requireValue(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), 'absolute_path_required');
	return path.resolve(value);
}
export function canonical(value) {
	let current = absolute(value); const tail = [];
	while (!fs.existsSync(current)) { tail.unshift(path.basename(current)); current = path.dirname(current); }
	return path.join(fs.realpathSync(current), ...tail);
}
export const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
export function privateDirectory(value, create = false) {
	const directory = absolute(value);
	if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const s = fs.lstatSync(directory);
	requireValue(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0 && s.uid === process.getuid(), 'private_directory_required');
	return directory;
}
export function privateFd(filename, maxBytes = 4096) {
	const fd = fs.openSync(absolute(filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const s = fs.fstatSync(fd);
		requireValue(s.isFile() && s.size > 0 && s.size <= maxBytes && (s.mode & 0o077) === 0 && s.uid === process.getuid(), 'private_file_required');
		return fd;
	} catch (error) { fs.closeSync(fd); throw error; }
}
export function privateText(filename, maxBytes = 65536) {
	const fd = privateFd(filename, maxBytes);
	try {
		const b = Buffer.alloc(maxBytes + 1); const size = fs.readSync(fd, b, 0, b.length, 0);
		requireValue(size <= maxBytes, 'configuration_too_large');
		return new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, size));
	} finally { fs.closeSync(fd); }
}
export function object(value, keys, code = 'invalid_fleet_configuration') {
	requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)), code);
	return value;
}
export function privateJson(filename) { return JSON.parse(privateText(filename)); }
export function socketPath(value) {
	const p = absolute(value);
	requireValue(Buffer.byteLength(p) < 100, 'unix_socket_path_too_long');
	return p;
}
export function writeJson(filename, value) {
	const temp = `${filename}.${process.pid}.tmp`;
	let fd;
	try {
		fd = fs.openSync(temp, 'wx', 0o600);
		fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
		fs.renameSync(temp, filename);
		const dir = fs.openSync(path.dirname(filename), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
	} finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}
export function safeCode(error) { return error instanceof ServiceError ? error.code : 'configuration_or_runtime_error'; }
