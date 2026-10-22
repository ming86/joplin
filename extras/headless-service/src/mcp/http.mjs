import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpSession, modernProtocolVersion, protocolVersions, rpcError, unsupportedProtocolVersion } from './session.mjs';

/** Preserve the session concurrency limit across otherwise independent POSTs. */
const maxDispatches = 8;
/** Give aborted backends a bounded interval to finish during shutdown. */
const shutdownMs = 5000;

/** Recognize JSON objects without accepting arrays or null. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Use the same request identifier bounds as the shared session. */
const validId = value => (typeof value === 'string' && value.length <= 256) || Number.isSafeInteger(value);

/** Accept exact browser origins, with no credentials or URL selectors. */
function validOrigin(value) {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password;
	} catch { return false; }
}

/** Hash both credentials to compare equal-length buffers without exposing token length. */
function credentialDigest(value) {
	return createHash('sha256').update(value).digest();
}

/** Honor the most specific JSON media range, including an explicit JSON exclusion. */
function acceptsJson(value) {
	if (value === undefined) return true;
	let best = -1;
	let quality = 0;
	for (const range of value.split(',')) {
		const [type, ...parameters] = range.trim().toLowerCase().split(';');
		const specificity = type.trim() === 'application/json' ? 2 : type.trim() === 'application/*' ? 1 : type.trim() === '*/*' ? 0 : -1;
		if (specificity < 0) continue;
		const q = parameters.find(parameter => parameter.trim().startsWith('q='));
		const weight = q === undefined ? 1 : Number(q.trim().slice(2));
		const acceptedWeight = Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0;
		if (specificity > best) { best = specificity; quality = acceptedWeight; }
		else if (specificity === best) quality = Math.max(quality, acceptedWeight);
	}
	return quality > 0;
}

/** Validate the transport envelope before dispatch, including ignorable client responses. */
function envelopeKind(message) {
	if (!record(message) || message.jsonrpc !== '2.0') return null;
	if (Object.hasOwn(message, 'method')) {
		if (typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && !validId(message.id))
			|| (message.params !== undefined && !record(message.params))
			|| Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) return null;
		return Object.hasOwn(message, 'id') ? 'request' : 'notification';
	}
	if (!Object.hasOwn(message, 'id') || !(message.id === null || validId(message.id))) return null;
	const hasResult = Object.hasOwn(message, 'result');
	const hasError = Object.hasOwn(message, 'error');
	if (hasResult === hasError || Object.hasOwn(message, 'params')) return null;
	if (hasError && (!record(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string')) return null;
	return 'response';
}

/** Decode the standard Mcp-Name sentinel before comparing a name or resource URI. */
function nameHeaderMatches(value, source) {
	if (typeof value !== 'string' || typeof source !== 'string') return false;
	if (value.startsWith('=?base64?') && value.endsWith('?=')) {
		const encoded = value.slice(9, -2);
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
		try {
			const bytes = Buffer.from(encoded, 'base64');
			return bytes.toString('base64') === encoded && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === source;
		} catch { return false; }
	}
	return /^[\x09\x20-\x7e]*$/.test(value) && value.trim() === value && value === source;
}

/** Match standard routing headers even for methods this tools-only server does not implement. */
function modernHeadersMatch(headers, message) {
	const metadata = message.params?._meta;
	const bodyVersion = record(metadata) ? metadata['io.modelcontextprotocol/protocolVersion'] : undefined;
	const nameField = message.method === 'resources/read' ? 'uri'
		: ['tools/call', 'prompts/get'].includes(message.method) ? 'name' : undefined;
	// Metadata shape is checked separately so malformed body fields remain parameter errors.
	return headers['mcp-protocol-version'] === modernProtocolVersion
		&& (typeof bodyVersion !== 'string' || bodyVersion === headers['mcp-protocol-version'])
		&& headers['mcp-method'] === message.method
		&& (nameField !== undefined
			? nameHeaderMatches(headers['mcp-name'], message.params?.[nameField])
			: headers['mcp-name'] === undefined);
}

/** Read JSON and decode UTF-8 strictly; disconnection only stops body collection. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let parts = [];
		let settled = false;
		/** Release buffered bytes immediately after a body failure. */
		function fail(code) {
			if (settled) return;
			settled = true;
			parts = [];
			reject(new Error(code));
		}
		req.on('data', part => {
			if (settled) return;
			parts.push(part);
		});
		req.on('error', () => fail('invalid_body'));
		req.on('aborted', () => fail('invalid_body'));
		req.on('end', () => {
			if (settled) return;
			try {
				const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
				settled = true;
				parts = [];
				resolve(message);
			} catch { fail('invalid_body'); }
		});
	});
}

/** Serve stateless MCP JSON POSTs bound to one operator-configured service. */
export async function startMcpHttpServer({ service, allowWrites = false, bearerToken, listenHost = '127.0.0.1', listenPort = 0, allowedOrigins = [] }) {
	if (typeof bearerToken !== 'string' || !bearerToken || /\s/.test(bearerToken)) throw new Error('invalid_mcp_http_token');
	if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new Error('invalid_mcp_http_port');
	if (typeof listenHost !== 'string' || !listenHost.trim()) throw new Error('invalid_mcp_http_host');
	if (!Array.isArray(allowedOrigins) || !allowedOrigins.every(validOrigin)) throw new Error('invalid_mcp_http_origins');
	const expectedCredential = credentialDigest(`Bearer ${bearerToken}`);
	const origins = new Set(allowedOrigins);
	const sessions = new Set();
	const probes = new Set();
	const pending = new Set();
	let closing = false;
	let closePromise;

	/** Send fixed transport errors or pre-serialized protocol output without writing to lost clients. */
	function respond(res, status, value, headers = {}) {
		if (res.destroyed || res.writableEnded) return;
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
		res.end(value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value));
	}

	/** Route each request while keeping transport and backend error details separate. */
	async function handle(req, res) {
		if (closing) return respond(res, 503, { error: 'server_closing' });
		if (!['/healthz', '/readyz', '/mcp'].includes(req.url)) return respond(res, 404, { error: 'not_found' });
		if (req.url === '/mcp' && !timingSafeEqual(expectedCredential, credentialDigest(req.headers.authorization ?? ''))) {
			return respond(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
		}
		if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) return respond(res, 403, { error: 'origin_not_allowed' });
		if (req.url !== '/mcp') {
			if (req.method !== 'GET') return respond(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
			if (req.url === '/healthz') return respond(res, 200, { ok: true });
			const controller = new AbortController();
			probes.add(controller);
			try {
				await service.listNoteSummaries({ limit: 1 }, controller.signal);
				respond(res, 200, { ready: true });
			} catch { respond(res, 503, { ready: false }); }
			finally { probes.delete(controller); }
			return;
		}
		if (req.method !== 'POST') return respond(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
		if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(req.headers['content-type'] ?? '')
			|| (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'].toLowerCase() !== 'identity')) return respond(res, 415, { error: 'json_required' });
		if (!acceptsJson(req.headers.accept)) return respond(res, 406, { error: 'json_response_required' });
		const version = req.headers['mcp-protocol-version'];
		let message;
		try { message = await readBody(req); }
		catch { return respond(res, 400, rpcError(null, -32700, 'Parse error')); }
		const kind = envelopeKind(message);
		if (!kind) return respond(res, 400, rpcError(null, -32600, 'Invalid Request'));
		if (version !== undefined && !protocolVersions.includes(version)) return respond(res, 400, unsupportedProtocolVersion(message.id ?? null, version));
		const modern = version === modernProtocolVersion || message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === modernProtocolVersion;
		if (modern && kind !== 'request') return respond(res, 400, rpcError(message.id ?? null, -32600, 'Invalid Request'));
		if (version === modernProtocolVersion) {
			const metadata = message.params?._meta;
			// The header can select modern behavior even when the body cannot select it in the session.
			if (!record(metadata) || typeof metadata['io.modelcontextprotocol/protocolVersion'] !== 'string'
				|| !record(metadata['io.modelcontextprotocol/clientCapabilities'])) {
				return respond(res, 400, rpcError(message.id ?? null, -32602, 'Invalid request metadata'));
			}
		}
		if (modern && !modernHeadersMatch(req.headers, message)) {
			return respond(res, 400, rpcError(message.id ?? null, -32020, 'Header mismatch'));
		}
		if (version === undefined && message.method !== 'initialize') return respond(res, 400, { error: 'protocol_version_required' });
		if (kind === 'response') return respond(res, 202);
		if (closing) return respond(res, 503, { error: 'server_closing' });
		if (sessions.size >= maxDispatches) return respond(res, 503, { error: 'too_many_requests' });
		const session = createMcpSession(service, { allowWrites, stateless: true });
		sessions.add(session);
		try {
			// A disconnected client does not cancel a write; only shutdown closes the session.
			const response = await session.handle(message);
			if (kind === 'notification') return respond(res, 202);
			const json = JSON.stringify(response);
			const errorCode = response.error?.code;
			const status = errorCode === -32022 ? 400 : modern && errorCode === -32601 ? 404 : modern && errorCode === -32602 ? 400 : 200;
			respond(res, status, json);
		} catch { respond(res, 200, rpcError(message.id ?? null, -32603, 'Internal error')); }
		finally { session.close(); sessions.delete(session); }
	}

	const server = http.createServer((req, res) => {
		const operation = handle(req, res).catch(() => respond(res, 500, { error: 'internal_error' }));
		pending.add(operation);
		void operation.finally(() => pending.delete(operation));
	});
	server.requestTimeout = 15000;
	server.headersTimeout = 10000;
	server.keepAliveTimeout = 5000;
	server.maxRequestsPerSocket = 100;
	await new Promise((resolve, reject) => {
		/** Remove the startup rejection listener once the socket is listening. */
		function listening() { server.removeListener('error', reject); resolve(); }
		server.once('error', reject);
		server.listen(listenPort, listenHost, listening);
	});
	const port = server.address().port;
	const urlHost = listenHost.includes(':') ? `[${listenHost}]` : listenHost;
	return {
		baseUrl: `http://${urlHost}:${port}`,
		port,
		/** Stop admission, abort explicit server work, and bound connection/backend draining. */
		close() {
			if (closePromise) return closePromise;
			closing = true;
			for (const session of sessions) session.close();
			for (const controller of probes) controller.abort();
			closePromise = new Promise(resolve => {
				const timer = setTimeout(() => { server.closeAllConnections(); resolve(); }, shutdownMs);
				const stopped = new Promise(done => server.close(done));
				server.closeIdleConnections();
				void Promise.allSettled([stopped, ...pending]).then(() => { clearTimeout(timer); resolve(); });
			});
			return closePromise;
		},
	};
}
