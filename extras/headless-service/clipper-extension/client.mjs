// Browser-only state is session-scoped. Never persist the bearer or clip body in
// storage.local/sync. A retry retains the entire original operation unchanged.
export function endpoint(value) {
	const u = new URL(value);
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('Use HTTPS, or loopback HTTP for local testing.');
	if (u.username || u.password || u.search || u.hash) throw new Error('Endpoint must not include credentials, query or fragment.');
	u.pathname = `${u.pathname.replace(/\/+$/, '')}/`;
	return u.href;
}
export function permissionPattern(value) {
	const u = new URL(endpoint(value));
	// Chrome host-match patterns grant by scheme/host; ports are not a scope.
	return `${u.protocol}//${u.hostname}/*`;
}
export function operation({ notebookId, title, text, sourceUrl }, id = crypto.randomUUID().replaceAll('-', '')) {
	if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{32}$/.test(notebookId)) throw new Error('Select a destination notebook.');
	const limits = [[title, 512], [text, 131072], [sourceUrl, 4096]];
	if (limits.some(([v, limit]) => typeof v !== 'string' || !v.trim() || new TextEncoder().encode(v).length > limit || v.includes('\0') || !v.isWellFormed()) || /[\r\n]/.test(title)) throw new Error('Enter a title and text within the size limits.');
	const u = new URL(sourceUrl);
	if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Source must be an HTTP(S) page without credentials.');
	u.hash = '';
	return { operationId: id, notebookId, title, text, sourceUrl: u.href };
}
export async function request(base, token, route, body, fetcher = fetch) {
	if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Enter the separate clipping token.');
	const res = await fetcher(new URL(route, endpoint(base)), {
		method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000),
		headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const reader = res.body.getReader(); let length = 0; const buffers = [];
	try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 65536) { await reader.cancel(); throw new Error('Response too large.'); } buffers.push(value); } } finally { reader.releaseLock(); }
	const bytes = new Uint8Array(length); let at = 0; for (const b of buffers) { bytes.set(b, at); at += b.length; }
	const result = JSON.parse(new TextDecoder().decode(bytes));
	if (!res.ok) throw new Error(`Clipping service returned HTTP ${res.status}. Keep the pending operation and retry after resolving the error.`);
	if (body && (result.saved !== 'local' || !/^[a-f0-9]{32}$/.test(result.noteId))) throw new Error('Unrecognized save response. Keep the pending operation.');
	return result;
}
