import type { Env } from './env';

/** Absolute request URL; the VPC Service fixes the actual localhost host and port. */
const MCP_ENDPOINT = 'http://localhost:41191/mcp';

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
export async function mcpForwarder(request: Request, env: Pick<Env, 'MCP_RATE_LIMITER' | 'JOPLIN_MCP' | 'JOPLIN_MCP_BEARER_TOKEN'>): Promise<Response> {
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

	const headers = new Headers();
	for (const name of REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	// OAuth credentials belong to the client-facing worker; the sidecar has its own token.
	headers.set('Authorization', `Bearer ${env.JOPLIN_MCP_BEARER_TOKEN}`);

	try {
		const upstream = await env.JOPLIN_MCP.fetch(MCP_ENDPOINT, {
			method: 'POST',
			headers,
			body: request.body,
			// Keep the private sidecar destination fixed even if it sends a redirect.
			redirect: 'manual',
		});
		return forwardedResponse(upstream);
	} catch {
		// Do not retry: a sidecar write may have completed before the transport failed.
		return errorResponse(502, 'upstream_unavailable');
	}
}
