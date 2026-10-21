# Joplin MCP OAuth proxy

This Worker exposes the headless sidecar through Google sign-in and OAuth. Access is restricted to the verified Google email `allowed@example.com`. An MCP client receives its own OAuth token; the Worker uses a separate bearer credential when forwarding to the configured sidecar.

The package uses the current `@cloudflare/workers-oauth-provider` consent and upstream transaction helpers. They keep consent and Google callbacks bound to the initiating browser, with one-time transactions in KV. Google ID tokens are checked against Google's signing keys, issuer, client audience, expiry, nonce, and verified-email claim. Email comparison ignores case; it does not normalize Gmail dots or aliases. Google access and refresh tokens are not retained.

## Routes and behavior

| Route | Purpose |
| --- | --- |
| `/.well-known/oauth-authorization-server` | OAuth server discovery |
| `/.well-known/oauth-protected-resource/mcp` | Protected resource discovery for `/mcp` |
| `/register` | Dynamic MCP client registration, with a 16 KiB JSON body limit and request limiting |
| `/authorize` | Client consent, followed by Google sign-in |
| `/oauth/google/callback` | Browser-bound Google callback and allowed-account check |
| `/token` | MCP authorization-code exchange, refresh, and provider-supported revocation |
| `/mcp` | Authenticated streaming forwarder for MCP POST requests |

The provider validates client redirect URIs, public-client PKCE, and the canonical resource audience. Consent displays client metadata and the return hostname before starting Google sign-in. Only the configured account can receive a grant or use a protected request. The default provider access-token lifetime is one hour and refresh-token lifetime is 30 days.

Forwarding always targets `/mcp` on `JOPLIN_MCP_ORIGIN_URL`, which must be an HTTPS origin with no path, query, credentials, or fragment. The Worker preserves MCP version/method/name headers, content metadata, Accept, and Origin. Configure the sidecar's `allowedOrigins` for any clients that send Origin; requests without Origin retain the sidecar's existing behavior. Client cookies and the client's OAuth bearer credential are not sent to the sidecar. Responses stream with `Cache-Control: no-store`. Redirects are not followed and failed requests are not retried, because a note write might already have completed. A client disconnect does not abort the sidecar fetch.

`MCP_RATE_LIMITER` allows 120 requests per 60 seconds for the account's MCP traffic. Registration uses a separate key per Cloudflare client IP on the same binding. Cloudflare rate limits are approximate and local to a Cloudflare location. Invocation logging is disabled because callback URLs contain codes and state; application logs use fixed events without tokens, email addresses, or request bodies.

## Configuration

Install SOPS locally and use a current supported Node.js release for tooling; Node.js 22 or later is required by Wrangler. Dependency versions are pinned in this package and its lockfile, independently of the parent repository. Use the latest stable versions where feasible when updating them.

Before deployment, set the actual canonical HTTPS origin in `wrangler.jsonc` as `PUBLIC_URL`, and replace the all-zero `OAUTH_KV` namespace ID with a namespace dedicated to this Worker. Keep `ALLOWED_GOOGLE_EMAIL` set to the intended account. The supplied hostname and namespace are placeholders, not provisioned resources.

Create a Google OAuth **web application** with this exact authorized redirect URI, substituting the configured public origin:

```text
https://your-worker-host/oauth/google/callback
```

If the Google consent app is in testing, add `allowed@example.com` as a test user. The requested Google scopes are `openid email profile`. The Worker also displays its own per-client consent page.

Add these four Worker secrets to `.sops.env`:

| Secret | Value |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Google web application's client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google web application's client secret |
| `JOPLIN_MCP_ORIGIN_URL` | Protected HTTPS origin serving the sidecar's `/mcp` |
| `JOPLIN_MCP_BEARER_TOKEN` | Same value as the sidecar's `bearerTokenFile` contents |

The sidecar and its origin route must be reachable by the Worker. Protect that route with the sidecar bearer credential; do not expose Joplin's internal Data API through this Worker. Origin/tunnel setup, Google application setup, and KV provisioning are separate setup steps.

## SOPS and age

The repository-root `.sops.yaml` already selects the public age recipient for `extras/cloudflare-mcp-worker/.sops.env`. From this package directory, create or edit the encrypted dotenv file directly:

```bash
sops edit .sops.env
```

On first use, add these entries in the editor:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=your-google-oauth-client-id
GOOGLE_OAUTH_CLIENT_SECRET=your-google-oauth-client-secret
JOPLIN_MCP_ORIGIN_URL=https://your-protected-joplin-sidecar.example
JOPLIN_MCP_BEARER_TOKEN=your-sidecar-bearer-token
```

SOPS saves the values encrypted in `.sops.env`; commit that file with the public recipient rule. Keep the matching age private key private. SOPS uses `~/.config/sops/age/keys.txt` by default; set `SOPS_AGE_KEY_FILE` when your identity is stored elsewhere.

From this directory, `npm run dev` decrypts the file to a temporary dotenv file and starts Wrangler with local HTTPS. `npm run deploy` passes the same temporary file to Wrangler's secrets upload option. Neither command requires a maintained plaintext `.dev.vars` file.

## Local checks

From this directory:

```bash
npm ci
npm run types
npm run typecheck
npm test
npm run test:worker
```

`npm test` covers signed Google identity verification and fixed-origin forwarding. `npm run test:worker` builds with Wrangler's dry-run command and runs one representative flow in its bundled workerd runtime: registration, consent, Google PKCE/OIDC, client PKCE exchange, and authenticated MCP forwarding. It also checks missing browser cookies, callback replay, and a disallowed account. Google and sidecar responses are synthetic; no real credentials or external services are used. Local runtime checks require permission to open loopback sockets.

`npm run build` only bundles with `wrangler deploy --dry-run`; it does not deploy. For manual browser sign-in during local development, use HTTPS and align `PUBLIC_URL` and the registered Google redirect URI with that origin, because the provider uses Secure `__Host-` cookies. `npm run dev` starts Wrangler with HTTPS.

Live Google sign-in, a selected remote MCP client, the protected origin, and VPS/container integration still need verification during deployment.
