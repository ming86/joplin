import { createHash } from 'node:crypto';
import { requireValue } from '../errors.mjs';

export const digest = text => createHash('sha256').update(text).digest('hex');
export function chunkSettings(config = {}) {
	const result = { version: 'utf8-title-body-v1', maxBytes: config.maxBytes ?? 2400, overlapBytes: config.overlapBytes ?? Math.min(240, Math.floor((config.maxBytes ?? 2400) / 10)), maxChunks: config.maxChunks ?? 2048 };
	requireValue(Number.isSafeInteger(result.maxBytes) && result.maxBytes >= 256 && result.maxBytes <= 65536);
	requireValue(Number.isSafeInteger(result.overlapBytes) && result.overlapBytes >= 0 && result.overlapBytes < result.maxBytes / 2);
	requireValue(Number.isSafeInteger(result.maxChunks) && result.maxChunks > 0 && result.maxChunks <= 8192);
	return Object.freeze(result);
}
export const chunkFingerprint = config => digest(JSON.stringify(chunkSettings(config)));
export function isIndexable(note) {
	return note && note.encryption_applied === 0 && !note.deleted_time && !note.is_locked && note.markup_language === 1 && typeof note.title === 'string' && typeof note.body === 'string';
}

// Bound UTF-8 bytes, not an invented model token count. Version this rule in
// index metadata. Title budget is explicit; the original note is not modified.
export function chunkNote(note, input) {
	const config = chunkSettings(input);
	const titleBytes = Buffer.from(note.title);
	let titleEnd = Math.min(titleBytes.length, Math.floor(config.maxBytes / 4));
	while (titleEnd > 0 && (titleBytes[titleEnd] & 0xc0) === 0x80) titleEnd--;
	const prefix = titleBytes.subarray(0, titleEnd).toString('utf8') + '\n\n';
	const budget = config.maxBytes - Buffer.byteLength(prefix);
	const data = Buffer.from(note.body); const chunks = [];
	let start = 0;
	do {
		let end = Math.min(start + budget, data.length);
		while (end < data.length && (data[end] & 0xc0) === 0x80) end--;
		const text = prefix + data.subarray(start, end).toString('utf8');
		if (text.trim()) chunks.push({ ordinal: chunks.length, start, end, text, hash: digest(text) });
		requireValue(chunks.length <= config.maxChunks, 'note_exceeds_chunk_limit');
		if (end === data.length) break;
		start = Math.max(start + 1, end - Math.min(config.overlapBytes, Math.floor(budget / 2)));
		while ((data[start] & 0xc0) === 0x80) start++;
	} while (start < data.length);
	return chunks;
}
export function fuseRanks(keyword, semantic, limit = 20) {
	const scores = new Map();
	for (const [items, source] of [[keyword, 'keyword'], [semantic, 'semantic']]) {
		const seen = new Set(); let rank = 0;
		for (const note of items) {
			if (seen.has(note.id)) continue; seen.add(note.id); rank++;
			const current = scores.get(note.id) ?? { note, score: 0, sources: [] };
			if (source === 'semantic') current.note = { ...current.note, ...note };
			current.score += 1 / (60 + rank); current.sources.push(source); scores.set(note.id, current);
		}
	}
	return [...scores.values()].sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id)).slice(0, limit)
		.map(item => ({ ...item.note, score: item.score, provenance: item.sources.length === 2 ? 'hybrid' : item.sources[0] }));
}
