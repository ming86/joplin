import type { Env } from './env';

/** MCP headers the sidecar needs to validate and process a stateless request. */
const REQUEST_HEADERS = [
	'accept',
	'content-encoding',
	'content-type',
	'mcp-method',
	'mcp-name',
	'mcp-protocol-version',
	'origin',
] as const;

/** Sidecar response headers that describe its body or MCP transport behavior. */
const RESPONSE_HEADERS = [
	'allow',
	'content-encoding',
	'content-length',
	'content-type',
	'mcp-protocol-version',
	'mcp-session-id',
	'mcp-session-terminated',
	'retry-after',
] as const;

/** Return a JSON error with the same cache policy used for MCP responses. */
function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set('Cache-Control', 'no-store');
	responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
	responseHeaders.set('X-Content-Type-Options', 'nosniff');
	return new Response(JSON.stringify({ error: message }), { status, headers: responseHeaders });
}

/** Resolve only a configured HTTPS origin and always target its fixed MCP route. */
function mcpEndpoint(configuredOrigin: string): URL | null {
	try {
		const origin = new URL(configuredOrigin);
		if (origin.protocol !== 'https:' || origin.username || origin.password
			|| origin.pathname !== '/' || origin.search || origin.hash) return null;
		return new URL('/mcp', origin.origin);
	} catch {
		return null;
	}
}

/** Copy only the MCP response metadata that is useful to its OAuth client. */
function forwardedResponse(upstream: Response): Response {
	const headers = new Headers();
	for (const name of RESPONSE_HEADERS) {
		const value = upstream.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	headers.set('Cache-Control', 'no-store');
	headers.set('X-Content-Type-Options', 'nosniff');
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

/** Forward authenticated MCP POSTs to this account's private Joplin sidecar. */
export async function mcpForwarder(request: Request, env: Pick<Env, 'MCP_RATE_LIMITER' | 'JOPLIN_MCP_ORIGIN_URL' | 'JOPLIN_MCP_BEARER_TOKEN'>): Promise<Response> {
	const incomingUrl = new URL(request.url);
	if (incomingUrl.pathname !== '/mcp') return errorResponse(404, 'not_found');
	if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', { Allow: 'POST' });

	let rateLimit: { success: boolean };
	try {
		rateLimit = await env.MCP_RATE_LIMITER.limit({ key: 'joplin-mcp' });
	} catch {
		return errorResponse(503, 'rate_limiter_unavailable');
	}
	if (!rateLimit.success) return errorResponse(429, 'rate_limited', { 'Retry-After': '60' });

	const endpoint = mcpEndpoint(env.JOPLIN_MCP_ORIGIN_URL);
	if (!endpoint) return errorResponse(502, 'upstream_unavailable');

	const headers = new Headers();
	for (const name of REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	// OAuth credentials belong to the client-facing worker; the sidecar has its own token.
	headers.set('Authorization', `Bearer ${env.JOPLIN_MCP_BEARER_TOKEN}`);

	try {
		const upstream = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: request.body,
			// Keep the configured sidecar origin fixed even if it sends a redirect.
			redirect: 'manual',
		});
		return forwardedResponse(upstream);
	} catch {
		// Do not retry: a sidecar write may have completed before the transport failed.
		return errorResponse(502, 'upstream_unavailable');
	}
}
