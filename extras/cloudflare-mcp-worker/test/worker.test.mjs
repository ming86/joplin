import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// Use Wrangler's own local runtime, so this check needs no second runtime dependency.
const { Miniflare } = createRequire(import.meta.resolve('wrangler'))('miniflare');
const PUBLIC_URL = 'https://joplin-mcp.example.com';
const CLIENT_ID = 'test-google-client';

/** Hash a verifier exactly as public MCP and Google OAuth clients do for PKCE. */
async function challenge(verifier) {
	return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
}

/** Extract the provider binding cookie without relying on a browser cookie jar. */
function cookie(response, prefix) {
	const header = response.headers.getSetCookie().find(value => value.startsWith(prefix));
	assert.ok(header, `Missing ${prefix} binding cookie`);
	return header.split(';')[0];
}

test('runs consent, Google OIDC, OAuth PKCE and authenticated forwarding in workerd', async t => {
	const { privateKey, publicKey } = await generateKeyPair('RS256');
	const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' };
	let googleNonce;
	let googleChallenge;
	let email = 'allowed@example.com';
	let sidecarCalls = 0;
	const variables = { PUBLIC_URL, ALLOWED_GOOGLE_EMAIL: email, GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
		GOOGLE_OAUTH_CLIENT_SECRET: 'test-google-secret', JOPLIN_MCP_ORIGIN_URL: 'https://sidecar.example.test', JOPLIN_MCP_BEARER_TOKEN: 'test-sidecar-secret' };
	const runtime = new Miniflare({ workers: [{
		config: {
			name: 'joplin-mcp', compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
			manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: readFileSync('dist/index.js', 'utf8') } } },
			env: { ...Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, { type: 'text', value }])),
				OAUTH_KV: { type: 'kv', id: 'OAUTH_KV' }, MCP_RATE_LIMITER: { type: 'rate-limit', namespace: '1001', simple: { limit: 120, period: 60 } } },
		},
		dev: { outboundService: { type: 'fetcher', async handler(request) {
			const url = new URL(request.url);
			if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
			if (url.href === 'https://oauth2.googleapis.com/token') {
				const form = new URLSearchParams(await request.text());
				assert.equal(form.get('client_secret'), 'test-google-secret');
				assert.equal(form.get('redirect_uri'), `${PUBLIC_URL}/oauth/google/callback`);
				assert.equal(await challenge(form.get('code_verifier')), googleChallenge);
				const idToken = await new SignJWT({ email, email_verified: true, nonce: googleNonce })
					.setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://accounts.google.com')
					.setAudience(CLIENT_ID).setSubject('test-google-subject').setExpirationTime('5m').sign(privateKey);
				return Response.json({ id_token: idToken });
			}
			assert.equal(url.href, 'https://sidecar.example.test/mcp');
			assert.equal(request.headers.get('Authorization'), 'Bearer test-sidecar-secret');
			assert.equal(request.headers.get('Mcp-Method'), 'tools/list');
			assert.equal(request.headers.get('MCP-Protocol-Version'), '2026-07-28');
			assert.equal(request.headers.has('Cookie'), false);
			sidecarCalls += 1;
			return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
		} } },
	}] });
	t.after(() => runtime.dispose());
	const send = (path, init) => runtime.dispatchFetch(`${PUBLIC_URL}${path}`, { redirect: 'manual', ...init });
	const metadata = await send('/.well-known/oauth-authorization-server');
	assert.equal((await metadata.json()).issuer, PUBLIC_URL);
	const unauthenticated = await send('/mcp', { method: 'POST', body: '{}' });
	assert.equal(unauthenticated.status, 401);
	assert.match(unauthenticated.headers.get('WWW-Authenticate'), /resource_metadata=/);
	assert.equal(sidecarCalls, 0);
	const registered = await send('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
		client_name: '<Example MCP client>', redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'none',
		grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
	}) });
	assert.equal(registered.status, 201, await registered.clone().text());
	const client = await registered.json();
	const verifier = 'a'.repeat(43);
	const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example.test/callback',
		response_type: 'code', state: 'original-mcp-state', scope: 'mcp', resource: `${PUBLIC_URL}/mcp`,
		code_challenge: await challenge(verifier), code_challenge_method: 'S256' });

	/** Begin a fresh browser-bound request, then approve its displayed client. */
	async function approve() {
		const page = await send(`/authorize?${params}`);
		assert.equal(page.status, 200, await page.clone().text());
		const html = await page.text();
		assert.match(html, /&lt;Example MCP client&gt;/);
		assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
		const handle = html.match(/name="handle" value="([^"]+)"/)[1];
		const body = new URLSearchParams({ handle, decision: 'approve' });
		const stolen = await send('/authorize', { method: 'POST', body });
		assert.equal(stolen.status, 400);
		const approved = await send('/authorize', { method: 'POST', body, headers: { Cookie: cookie(page, '__Host-oauth-consent-') } });
		assert.equal(approved.status, 302, await approved.clone().text());
		const google = new URL(approved.headers.get('Location'));
		assert.equal(google.origin, 'https://accounts.google.com');
		assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
		googleNonce = google.searchParams.get('nonce');
		googleChallenge = google.searchParams.get('code_challenge');
		return { state: google.searchParams.get('state'), cookie: cookie(approved, '__Host-oauth-upstream-') };
	}

	const upstream = await approve();
	const callback = `/oauth/google/callback?${new URLSearchParams({ code: 'google-code', state: upstream.state })}`;
	assert.equal((await send(callback)).status, 400);
	const signedIn = await send(callback, { headers: { Cookie: upstream.cookie } });
	assert.equal(signedIn.status, 302, await signedIn.clone().text());
	const destination = new URL(signedIn.headers.get('Location'));
	assert.equal(destination.origin, 'https://client.example.test');
	assert.equal(destination.searchParams.get('state'), 'original-mcp-state');
	assert.equal(destination.searchParams.get('iss'), PUBLIC_URL);
	assert.ok(destination.searchParams.get('code'));
	assert.equal((await send(callback, { headers: { Cookie: upstream.cookie } })).status, 400);
	const token = await send('/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code',
		client_id: client.client_id, code: destination.searchParams.get('code'), code_verifier: verifier,
		redirect_uri: 'https://client.example.test/callback', resource: `${PUBLIC_URL}/mcp` }) });
	assert.equal(token.status, 200, await token.clone().text());
	const credentials = await token.json();
	assert.ok(credentials.access_token);
	const result = await send('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${credentials.access_token}`,
		'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
	assert.equal(result.status, 200);
	assert.deepEqual(await result.json(), { jsonrpc: '2.0', id: 1, result: { tools: [] } });
	assert.equal(sidecarCalls, 1);

	email = 'someone-else@example.com';
	const deniedUpstream = await approve();
	const denied = await send(`/oauth/google/callback?${new URLSearchParams({ code: 'another-google-code', state: deniedUpstream.state })}`,
		{ headers: { Cookie: deniedUpstream.cookie } });
	const deniedDestination = new URL(denied.headers.get('Location'));
	assert.equal(deniedDestination.searchParams.get('error'), 'access_denied');
	assert.equal(deniedDestination.searchParams.has('code'), false);
	assert.equal(sidecarCalls, 1);
});
