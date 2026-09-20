import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { requireValue, ServiceError } from '../errors.mjs';
import { MAX_BODY_BYTES } from './service.mjs';
import { PREVIEW_STYLE } from '../../web/preview.mjs';
const digest = text => createHash('sha256').update(text).digest();
const staticFiles = new Map([
	['/', ['index.html', 'text/html; charset=utf-8']],
	['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
	['/draft.mjs', ['draft.mjs', 'text/javascript; charset=utf-8']],
	['/preview.mjs', ['preview.mjs', 'text/javascript; charset=utf-8']],
	['/app.css', ['app.css', 'text/css; charset=utf-8']],
	['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
	['/icon-192.png', ['icon-192.png', 'image/png']], ['/icon-512.png', ['icon-512.png', 'image/png']],
]);
export function webOrigin(value) {
	let u; try { u = new URL(value); } catch { throw new ServiceError('invalid_web_origin'); }
	requireValue(!u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'invalid_web_origin');
	requireValue(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)), 'web_https_required');
	return u;
}
const previewStyleHash = createHash('sha256').update(PREVIEW_STYLE).digest('base64');
const csp = `default-src 'none'; script-src 'self'; style-src 'self' 'sha256-${previewStyleHash}'; connect-src 'self'; img-src 'self'; manifest-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
function reply(res, status, value, headers = {}) {
	if (res.destroyed) return;
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
	res.end(JSON.stringify(value));
}
async function jsonBody(req) {
	requireValue(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''), 'json_required');
	const maxBytes = MAX_BODY_BYTES * 6 + 16384; // JSON escapes can expand the original text.
	requireValue(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'unsupported_content_encoding');
	requireValue(Number(req.headers['content-length'] ?? 0) <= maxBytes, 'web_request_too_large');
	const parts = []; let size = 0;
	for await (const part of req) {
		size += part.length; requireValue(size <= maxBytes, 'web_request_too_large'); parts.push(part);
	}
	try {
		const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
		requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid_json'); return value;
	} catch { throw new ServiceError('invalid_json'); }
}
const errorStatus = code => ({ operation_not_permitted: 403, stale_note: 409, web_creation_conflict: 409, unsupported_note_format: 409, note_unavailable: 404, not_found: 404, json_required: 415, unsupported_content_encoding: 415, web_request_too_large: 413, web_busy: 429 }[code] ?? (code.startsWith('invalid_') ? 400 : 503));

/** Host/Origin binding is explicit; forwarding headers never establish trust.
 * A TLS proxy must preserve Host and Origin. No API token, keys or routes are forwarded to the browser. */
export async function startWebServer({ service, token, port = 0, publicOrigin, sessionMs = 3600000, now = Date.now }) {
	requireValue(/^[A-Za-z0-9_-]{32,256}$/.test(token), 'invalid_web_token');
	requireValue(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'invalid_web_port');
	requireValue(Number.isSafeInteger(sessionMs) && sessionMs >= 1000 && sessionMs <= 86400000, 'invalid_session_duration');
	let origin = publicOrigin ? webOrigin(publicOrigin) : null;
	const sessions = new Map(), controllers = new Set();
	let closing = false, attempts = 0, loginWindow = now(), requests = 0, requestWindow = now();
	const tokenHash = digest(token);
	// Session cookie has no Domain and no persistent expiry. Server TTL is authoritative.
	const cookieName = () => origin.protocol === 'https:' ? '__Host-joplin_web' : 'joplin_web_loopback';
	const cookie = value => `${cookieName()}=${value}; Path=/; HttpOnly; SameSite=Strict${origin.protocol === 'https:' ? '; Secure' : ''}${value ? '' : '; Max-Age=0'}`;
	function session(req) {
		const cookies = String(req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(cookieName() + '='));
		if (cookies.length !== 1) return null;
		const key = cookies[0].slice(cookieName().length + 1);
		const expires = sessions.get(key);
		if (!expires || expires <= now()) { sessions.delete(key); return null; }
		return key;
	}
	const server = http.createServer(async (req, res) => {
		res.setHeader('Content-Security-Policy', csp);
		res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
		res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
		res.setHeader('Cache-Control', 'no-store');
		if (origin.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
		const controller = new AbortController(); controllers.add(controller);
		req.once('aborted', () => controller.abort());
		res.once('close', () => { controllers.delete(controller); if (!res.writableFinished) controller.abort(); });
		try {
			if (closing) return reply(res, 503, { error: 'web_stopping' });
			if (req.headers.host !== origin.host || !req.url.startsWith('/') || req.url.startsWith('//')) return reply(res, 403, { error: 'invalid_host' });
			const url = new URL(req.url, origin), route = url.pathname;
			// Static allowlist only, no filesystem path supplied by requests.
			if (req.method === 'GET' && staticFiles.has(route) && !url.search) {
				const [filename, contentType] = staticFiles.get(route);
				const data = await readFile(new URL(`../../web/${filename}`, import.meta.url));
				res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'Content-Length': data.length }); return res.end(data);
			}
			if (!route.startsWith('/api/')) return reply(res, 404, { error: 'not_found' });
			// This header plus no CORS permission excludes cross-origin browser reads.
			if (req.headers['x-joplin-web'] !== '1' || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') || (req.headers.origin && req.headers.origin !== origin.origin) || (req.method !== 'GET' && req.headers.origin !== origin.origin)) return reply(res, 403, { error: 'same_origin_required' });
			if (now() - requestWindow >= 60000) { requestWindow = now(); requests = 0; }
			if (++requests > 600) return reply(res, 429, { error: 'web_rate_limited' }, { 'Retry-After': '60' });
			if (route === '/api/login' && req.method === 'POST' && !url.search) {
				if (now() - loginWindow >= 60000) { loginWindow = now(); attempts = 0; }
				if (++attempts > 10) return reply(res, 429, { error: 'login_rate_limited' }, { 'Retry-After': '60' });
				const input = await jsonBody(req);
				if (Object.keys(input).length !== 1 || typeof input.token !== 'string' || input.token.length > 256 || !timingSafeEqual(digest(input.token), tokenHash)) return reply(res, 401, { error: 'invalid_web_credential' });
				const old = session(req); if (old) sessions.delete(old);
				for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
				if (sessions.size >= 32) return reply(res, 429, { error: 'session_limit' });
				const key = randomBytes(32).toString('hex'); sessions.set(key, now() + sessionMs);
				return reply(res, 200, { authenticated: true }, { 'Set-Cookie': cookie(key) });
			}
			const key = session(req); if (!key) return reply(res, 401, { error: 'authentication_required' });
			if (route === '/api/logout' && req.method === 'POST' && !url.search) { sessions.delete(key); return reply(res, 200, { authenticated: false }, { 'Set-Cookie': cookie('') }); }
			if (route === '/api/status' && req.method === 'GET' && !url.search) return reply(res, 200, await service.status(controller.signal));
			if (['/api/notebooks', '/api/notes'].includes(route) && req.method === 'GET') {
				requireValue([...url.searchParams.keys()].every(k => ['page', 'limit', ...(route === '/api/notes' ? ['notebookId'] : [])].includes(k)) && new Set(url.searchParams.keys()).size === [...url.searchParams.keys()].length, 'invalid_query');
				const options = { page: Number(url.searchParams.get('page') ?? 1), limit: Number(url.searchParams.get('limit') ?? 30) };
				if (url.searchParams.has('notebookId')) options.notebookId = url.searchParams.get('notebookId');
				return reply(res, 200, await service[route === '/api/notes' ? 'notes' : 'notebooks'](options, controller.signal));
			}
			if (/^\/api\/note\/[a-f0-9]{32}$/.test(route) && req.method === 'GET' && !url.search) return reply(res, 200, await service.get(route.split('/').pop(), controller.signal));
			if (['/api/write', '/api/search', '/api/preview'].includes(route) && req.method === 'POST' && !url.search) {
				const operation = route.slice('/api/'.length);
				return reply(res, 200, await service[operation](await jsonBody(req), controller.signal));
			}
			return reply(res, 404, { error: 'not_found' });
		} catch (error) {
			const code = error instanceof ServiceError ? error.code : 'web_service_unavailable';
			reply(res, errorStatus(code), { error: code, ...(error.outcomeUnknown ? { outcome: 'unknown', retry: 'same_operation_only' } : {}) });
		}
	});
	server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	origin ??= webOrigin(baseUrl);
	let closePromise;
	return { baseUrl, origin: origin.origin, port: server.address().port, close() {
		if (closePromise) return closePromise;
		closing = true; sessions.clear();
		closePromise = new Promise(resolve => {
			const timer = setTimeout(() => { for (const c of controllers) c.abort(); server.closeAllConnections(); }, 10000);
			server.close(() => { clearTimeout(timer); resolve(); }); server.closeIdleConnections();
		});
		return closePromise;
	} };
}
