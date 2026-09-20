import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ServiceError, requireValue } from '../errors.mjs';

const maxBytes = 1024 * 1024;
function bodyJson(req) {
	return new Promise((resolve, reject) => {
		let size = 0; let parts = []; let failed = false;
		const fail = code => { if (!failed) { failed = true; parts = []; reject(new ServiceError(code)); } };
		req.on('data', part => { if (failed) return; size += part.length; if (size > maxBytes) return fail('clip_request_too_large'); parts.push(part); });
		req.on('aborted', () => fail('request_cancelled')); req.on('error', () => fail('request_cancelled'));
		req.on('end', () => { if (failed) return; try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { fail('invalid_clip'); } });
	});
}
function validOrigin(value) {
	try {
		const u = new URL(value);
		return ((u.protocol === 'https:' && u.origin === value) || (/^chrome-extension:\/\/[a-p]{32}$/.test(value))) && !u.username && !u.password;
	} catch { return false; }
}
export async function startClipServer({ service, token, port = 0, allowedOrigins = [], publicOrigin, requestsPerMinute = 60 }) {
	requireValue(/^[A-Za-z0-9_-]{32,256}$/.test(token), 'invalid_clip_token');
	requireValue(Array.isArray(allowedOrigins) && allowedOrigins.length <= 20 && allowedOrigins.every(validOrigin), 'invalid_clip_origins');
	requireValue(publicOrigin === undefined || (validOrigin(publicOrigin) && publicOrigin.startsWith('https:')), 'invalid_public_origin');
	requireValue(Number.isSafeInteger(requestsPerMinute) && requestsPerMinute > 0 && requestsPerMinute <= 1000);
	const origins = new Set(allowedOrigins), controllers = new Set(); let windowStart = Date.now(), count = 0; let closing = false;
	const expectedToken = Buffer.from(`Bearer ${token}`); let authority;
	function respond(res, status, value, extra = {}) {
		if (res.destroyed || res.writableEnded) return;
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
		res.end(JSON.stringify(value));
	}
	const server = http.createServer(async (req, res) => {
		const controller = new AbortController(); controllers.add(controller);
		res.once('close', () => { controllers.delete(controller); controller.abort(); });
		try {
			if (closing || controllers.size > 32) return respond(res, 503, { error: 'clip_busy' });
			if (![authority, `localhost:${server.address().port}`, ...(publicOrigin ? [new URL(publicOrigin).host] : [])].includes(req.headers.host)) return respond(res, 403, { error: 'host_not_allowed' });
			const origin = req.headers.origin;
			if (origin !== undefined && !origins.has(origin)) return respond(res, 403, { error: 'origin_not_allowed' });
			if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
			const route = req.url;
			if (!['/v1/clips', '/v1/notebooks'].includes(route)) return respond(res, 404, { error: 'not_found' });
			if (req.method === 'OPTIONS') {
				const requestedHeaders = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
				if (!origin || !['POST', 'GET'].includes(req.headers['access-control-request-method']) || !requestedHeaders.every(s => ['authorization', 'content-type'].includes(s))) return respond(res, 403, { error: 'preflight_not_allowed' });
				res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' }); res.end(); return;
			}
			const provided = Buffer.from(req.headers.authorization ?? '');
			if (provided.length !== expectedToken.length || !timingSafeEqual(provided, expectedToken)) return respond(res, 401, { error: 'unauthorized' });
			if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); count = 0; }
			if (++count > requestsPerMinute) return respond(res, 429, { error: 'clip_rate_limited' }, { 'Retry-After': '60' });
			if (route === '/v1/notebooks' && req.method === 'GET') return respond(res, 200, await service.notebooks(controller.signal));
			if (route !== '/v1/clips' || req.method !== 'POST') return respond(res, 405, { error: 'method_not_allowed' });
			if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return respond(res, 415, { error: 'json_required' });
			if (Number(req.headers['content-length'] ?? 0) > maxBytes) return respond(res, 413, { error: 'clip_request_too_large' }, { Connection: 'close' });
			const result = await service.submit(await bodyJson(req), controller.signal);
			respond(res, result.replayed ? 200 : 201, result);
		} catch (error) {
			const code = error instanceof ServiceError ? error.code : 'clip_service_unavailable';
			const status = code === 'clip_operation_conflict' ? 409 : code === 'clip_notebook_not_permitted' ? 403 : code === 'clip_request_too_large' ? 413 : code.startsWith('invalid_') ? 400 : 503;
			respond(res, status, { error: code, ...(error.outcomeUnknown ? { outcome: 'unknown', retry: 'same_operation_only' } : {}) });
		}
	});
	server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
	authority = `127.0.0.1:${server.address().port}`;
	let closePromise;
	return { port: server.address().port, baseUrl: `http://${authority}`, close() {
		if (closePromise) return closePromise;
		closing = true;
		closePromise = new Promise(resolve => {
			const timer = setTimeout(() => { for (const c of controllers) c.abort(); server.closeAllConnections(); }, 10000);
			server.close(() => { clearTimeout(timer); resolve(); }); server.closeIdleConnections();
		});
		return closePromise;
	} };
}
