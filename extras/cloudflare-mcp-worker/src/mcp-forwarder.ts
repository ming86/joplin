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

/** Return bounded machine-readable error fields without retaining arbitrary message text. */
function safeErrorDetails(error: unknown, depth = 0, seen = new Set<Error>()): Record<string, unknown> | undefined {
	if (!(error instanceof Error) || depth >= 8 || seen.has(error)) return undefined;
	seen.add(error);
	const read = (key: string): unknown => {
		try {
			return (error as unknown as Record<string, unknown>)[key];
		} catch {
			return undefined;
		}
	};
	const details: Record<string, unknown> = { name: safeDiagnosticName(read('name')) ?? 'Error' };
	const code = safeDiagnosticName(read('code'));
	if (code) details.code = code;
	const errno = read('errno');
	if (typeof errno === 'number' && Number.isFinite(errno)) details.errno = errno;
	const syscall = safeDiagnosticName(read('syscall'));
	if (syscall) details.syscall = syscall;
	const message = read('message');
	if (typeof message === 'string' && SAFE_RUNTIME_MESSAGES.has(message)) details.message = message;
	const stack = read('stack');
	const frames = stackFrames(stack);
	if (frames.length) details.stack = frames;
	const cause = safeErrorDetails(read('cause'), depth + 1, seen);
	if (cause) details.cause = cause;
	return details;
}

/** Match the sidecar's fixed machine-name and generic runtime-message allowlists. */
function safeDiagnosticName(value: unknown): string | undefined {
	return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(value) ? value : undefined;
}

const SAFE_RUNTIME_MESSAGES = new Set([
	'fetch failed',
	'terminated',
	'The operation was aborted.',
	'This operation was aborted',
	'The operation was aborted due to timeout',
	'The operation was aborted',
]);

/** Extract stack locations while dropping headlines, query strings, and arbitrary stack text. */
function stackFrames(stack: unknown): string[] {
	if (typeof stack !== 'string') return [];
	return stack.split('\n').slice(1).flatMap(line => {
		if (!/^\s+at /.test(line)) return [];
		const match = line.match(/(?:\(|\s)((?:file:\/\/\/|node:|\/)[^\s()]+:\d+:\d+\)?)$/);
		if (!match) return [];
		const location = match[1].replace(/\)$/, '');
		return /[?#@]/.test(location) ? [] : [location];
	}).slice(0, 8);
}

/** Emit one structured diagnostic for a forwarding failure without including request data. */
function logForwardingFailure(input: {
	operation: 'forward_mcp';
	layer: 'vpc_service_binding' | 'upstream_http';
	startedAt: number;
	status?: number;
	error?: unknown;
}): void {
	console.error(JSON.stringify({
		event: 'mcp_forwarding_failure',
		operation: input.operation,
		layer: input.layer,
		elapsed_ms: Date.now() - input.startedAt,
		...(input.status === undefined ? {} : { status: input.status }),
		...(input.error === undefined ? {} : { error: safeErrorDetails(input.error) }),
	}));
}

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
export async function mcpForwarder(request: Request, env: Pick<Env, 'JOPLIN_MCP' | 'JOPLIN_MCP_BEARER_TOKEN'>): Promise<Response> {
	const incomingUrl = new URL(request.url);
	if (incomingUrl.pathname !== '/mcp') return errorResponse(404, 'not_found');
	if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', { Allow: 'POST' });

	const headers = new Headers();
	for (const name of REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	// OAuth credentials belong to the client-facing worker; the sidecar has its own token.
	headers.set('Authorization', `Bearer ${env.JOPLIN_MCP_BEARER_TOKEN}`);

	const upstreamStartedAt = Date.now();
	try {
		const upstream = await env.JOPLIN_MCP.fetch(MCP_ENDPOINT, {
			method: 'POST',
			headers,
			body: request.body,
			// Keep the private sidecar destination fixed even if it sends a redirect.
			redirect: 'manual',
		});
		if (upstream.status === 401 || upstream.status === 403 || upstream.status >= 500) {
			logForwardingFailure({
				operation: 'forward_mcp',
				layer: 'upstream_http',
				startedAt: upstreamStartedAt,
				status: upstream.status,
			});
		}
		return forwardedResponse(upstream);
	} catch (error) {
		// Do not retry: a sidecar write may have completed before the transport failed.
		logForwardingFailure({
			operation: 'forward_mcp',
			layer: 'vpc_service_binding',
			startedAt: upstreamStartedAt,
			error,
		});
		return errorResponse(502, 'upstream_unavailable');
	}
}
