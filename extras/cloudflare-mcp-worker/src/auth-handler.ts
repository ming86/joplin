import { AuthorizationError, authorizationErrorRedirect, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';
import { isAllowedGoogleIdentity, verifyGoogleIdToken } from './google-oidc';
import { log } from './logger';

/** Private upstream data encrypted by the provider and bound to this browser. */
interface GoogleTransaction {
	/** Google PKCE verifier; never supplied by the MCP client. */
	verifier: string;
	/** Nonce that must match the signed Google ID token. */
	nonce: string;
}

/** Escape all client-controlled strings before putting them into HTML. */
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Show the client and destination before allowing it to start Google sign-in. */
function consentPage(details: ConsentDescription, handle: string): string {
	const scopes = details.scope.length ? details.scope.map(escapeHtml).join(', ') : 'Joplin MCP access';
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Joplin</title><body><main>
<h1>Connect to Joplin</h1><p><strong>${escapeHtml(details.clientName)}</strong> is requesting access to your Joplin MCP tools.</p>
${details.clientDomain ? `<p>Client domain: ${escapeHtml(details.clientDomain)}</p>` : ''}
<p>Permissions: ${scopes}</p><p>Return destination: <strong>${escapeHtml(details.redirectHost)}</strong>${details.redirectIsLoopback ? ' (an app on this device)' : ''}</p>
<p>Continue only if you started this connection and trust this client. You will sign in with Google next.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><button name="decision" value="approve">Continue with Google</button> <button name="decision" value="deny">Cancel</button></form>
</main></body></html>`;
}

/** Return a fixed local error without exposing OAuth payloads or secrets. */
function failure(status: number, message: string, headers: Headers = new Headers()): Response {
	headers.set('Cache-Control', 'no-store');
	headers.set('Content-Type', 'text/plain; charset=utf-8');
	headers.set('X-Content-Type-Options', 'nosniff');
	return new Response(message, { status, headers });
}

/** Redirect while preserving provider-set browser binding and cleanup cookies. */
function redirect(location: string, headers: Headers): Response {
	headers.set('Location', location);
	headers.set('Cache-Control', 'no-store');
	return new Response(null, { status: 302, headers });
}

/** Encode random bytes or a SHA-256 digest in OAuth's unpadded base64url form. */
function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Render consent for a library-validated authorization request. */
async function authorize(request: Request, env: Env): Promise<Response> {
	let authRequest;
	try {
		authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo, new Headers());
		throw error;
	}
	const details = await env.OAUTH_PROVIDER.describeConsent(authRequest);
	const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
	consent.headers.set('Content-Type', 'text/html; charset=utf-8');
	return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

/** Consume the browser-bound consent before starting a Google authorization. */
async function submitConsent(request: Request, env: Env): Promise<Response> {
	const form = await request.formData();
	const handle = form.get('handle');
	if (typeof handle !== 'string') return failure(400, 'Invalid consent request.');
	if (form.get('decision') === 'deny') {
		const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	if (form.get('decision') !== 'approve') return failure(400, 'Invalid consent decision.');
	const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
	const upstream = await env.OAUTH_PROVIDER.beginUpstream(approved.request, { data: { verifier, nonce }, headers: approved.headers });
	const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
	google.search = new URLSearchParams({
		client_id: env.GOOGLE_OAUTH_CLIENT_ID,
		redirect_uri: `${env.PUBLIC_URL}/oauth/google/callback`,
		response_type: 'code',
		scope: 'openid email profile',
		state: upstream.state,
		nonce,
		code_challenge: challenge,
		code_challenge_method: 'S256',
	}).toString();
	return redirect(google.href, upstream.headers);
}

/** Verify Google's response before issuing any Joplin OAuth grant. */
async function googleCallback(request: Request, env: Env): Promise<Response> {
	const resumed = await env.OAUTH_PROVIDER.finishUpstream<GoogleTransaction>(request);
	const url = new URL(request.url);
	if (url.searchParams.has('error')) return redirect(authorizationErrorRedirect(resumed.request, 'access_denied'), resumed.headers);
	const code = url.searchParams.get('code');
	if (!code) return failure(400, 'Google authorization code is missing.', resumed.headers);
	let tokenResponse;
	try {
		tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
				code, code_verifier: resumed.data.verifier, grant_type: 'authorization_code', redirect_uri: `${env.PUBLIC_URL}/oauth/google/callback` }),
			redirect: 'manual',
		});
	} catch {
		log.error('google_token_exchange_failed');
		return failure(502, 'Google sign-in is unavailable. Start the connection again.', resumed.headers);
	}
	if (!tokenResponse.ok) {
		return failure(tokenResponse.status >= 500 ? 502 : 400, 'Google sign-in failed. Start the connection again.', resumed.headers);
	}
	let identity;
	try {
		const tokens = await tokenResponse.json() as { id_token?: unknown };
		if (typeof tokens.id_token !== 'string') throw new Error('Missing ID token');
		identity = await verifyGoogleIdToken({ idToken: tokens.id_token, clientId: env.GOOGLE_OAUTH_CLIENT_ID, expectedNonce: resumed.data.nonce });
	} catch {
		log.warn('google_identity_rejected');
		return redirect(authorizationErrorRedirect(resumed.request, 'access_denied'), resumed.headers);
	}
	if (!isAllowedGoogleIdentity(identity, env.ALLOWED_GOOGLE_EMAIL)) {
		log.warn('google_account_rejected');
		return redirect(authorizationErrorRedirect(resumed.request, 'access_denied'), resumed.headers);
	}
	const completed = await env.OAUTH_PROVIDER.completeAuthorization({ request: resumed.request, userId: identity.sub,
		metadata: { name: identity.name }, scope: resumed.request.scope, props: identity });
	return redirect(completed.redirectTo, resumed.headers);
}

/** Handle consent and Google callbacks; the provider handles registration and tokens. */
export async function authHandler(request: Request, env: Env): Promise<Response> {
	try {
		const path = new URL(request.url).pathname;
		if (path === '/authorize' && request.method === 'GET') return await authorize(request, env);
		if (path === '/authorize' && request.method === 'POST') return await submitConsent(request, env);
		if (path === '/oauth/google/callback' && request.method === 'GET') return await googleCallback(request, env);
		return failure(404, 'Not found.');
	} catch (error) {
		if (error instanceof AuthorizationError) return failure(400, 'Invalid or expired authorization request. Start the connection again.');
		log.error('authorization_failed');
		return failure(500, 'Authorization failed. Start the connection again.');
	}
}
