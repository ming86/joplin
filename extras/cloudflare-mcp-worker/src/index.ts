import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { authHandler } from './auth-handler';
import type { Bindings, Env } from './env';
import { isAllowedGoogleIdentity, type GoogleIdentity } from './google-oidc';
import { log } from './logger';
import { mcpForwarder } from './mcp-forwarder';

/** Maximum JSON client registration body; client metadata is small. */
const MAX_REGISTRATION_BYTES = 16_384;

/** Access tokens remain valid for one hour. */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** New refresh grants start with a 180-day lifetime. */
const REFRESH_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;

/** Successful refreshes slide the grant's inactivity expiry by the same 180 days. */
const REFRESH_TOKEN_IDLE_TTL_SECONDS = REFRESH_TOKEN_TTL_SECONDS;

/** Read a registration body with a fixed bound before handing it to the provider. */
async function guardedRegistration(request: Request, env: Bindings): Promise<Request | Response> {
	if (request.method !== 'POST') return request;
	const limited = await env.MCP_RATE_LIMITER.limit({ key: `register:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` });
	if (!limited.success) return new Response('Too many registrations.', { status: 429, headers: { 'Retry-After': '60' } });
	if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
		return new Response('JSON registration required.', { status: 415 });
	}
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	if (reader) {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_REGISTRATION_BYTES) {
				await reader.cancel();
				return new Response('Registration too large.', { status: 413 });
			}
			chunks.push(value);
		}
	}
	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
	return new Request(request.url, { method: request.method, headers: request.headers, body });
}

/** Build provider routes and metadata from the configured canonical public origin. */
function createProvider(env: Bindings): OAuthProvider<Env> {
	const origin = new URL(env.PUBLIC_URL);
	if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_URL) throw new Error('PUBLIC_URL must be a canonical HTTPS origin');
	return new OAuthProvider<Env>({
		apiRoute: `${env.PUBLIC_URL}/mcp`,
		apiHandler: {
			async fetch(request, bindings, ctx) {
				const identity = ctx.props as GoogleIdentity | undefined;
				if (!identity || typeof identity.email !== 'string' || !isAllowedGoogleIdentity(identity, bindings.ALLOWED_GOOGLE_EMAIL)) {
					return new Response('Access denied.', { status: 403 });
				}
				return mcpForwarder(request, bindings);
			},
		},
		defaultHandler: { fetch: authHandler },
		authorizeEndpoint: `${env.PUBLIC_URL}/authorize`,
		tokenEndpoint: `${env.PUBLIC_URL}/token`,
		clientRegistrationEndpoint: `${env.PUBLIC_URL}/register`,
		resourceMetadata: { resource: `${env.PUBLIC_URL}/mcp`, authorization_servers: [env.PUBLIC_URL], resource_name: 'Joplin MCP' },
		scopesSupported: ['mcp'],
		accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
		refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
		refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SECONDS,
		// Avoid the library's default diagnostic messages, which may contain client data.
		onError: ({ status }) => { log.warn('oauth_request_rejected', { status }); },
	});
}

/** Serve a single-account OAuth proxy without retaining request-bound helpers globally. */
export default {
	async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
		try {
			if (new URL(request.url).pathname === '/register') {
				const guarded = await guardedRegistration(request, env);
				if (guarded instanceof Response) return guarded;
				request = guarded;
			}
			// The provider injects OAUTH_PROVIDER; isolate that mutation to this request.
			return await createProvider(env).fetch(request, { ...env } as Env, ctx);
		} catch {
			log.error('worker_request_failed');
			return new Response('Service unavailable.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
		}
	},
};
