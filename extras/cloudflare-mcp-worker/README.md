# Joplin MCP OAuth proxy

This Worker protects the public MCP endpoint with Google sign-in and OAuth. Only the verified Google email `allowed@example.com` can receive a grant. The Worker forwards authenticated MCP requests through a Cloudflare Workers VPC Service to the private headless sidecar. The public origin is `https://joplin-mcp.example.com`; the sidecar itself has no public hostname or HTTP route.

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

The provider validates client redirect URIs, public-client PKCE, and the canonical resource audience. Consent displays client metadata and the return hostname before starting Google sign-in. Only the configured account can receive a grant or use a protected request. Access tokens last one hour. New refresh grants expire after 365 days without a successful refresh, and each successful refresh rotates the refresh token and slides the grant expiry another 365 days. Existing unexpired grants adopt the sliding window at their next successful refresh; expired grants remain expired.

Forwarding always uses the VPC binding `JOPLIN_MCP` and the fixed URL `http://localhost:41191/mcp`. The VPC Service maps that request to `localhost:41191` through the existing Cloudflare Tunnel. The Worker preserves MCP version/method/name headers, content metadata, Accept, and Origin. It replaces the client's OAuth credential with `JOPLIN_MCP_BEARER_TOKEN`; client cookies and OAuth credentials are not sent to the sidecar. Responses stream with `Cache-Control: no-store`. Redirects are not followed and failed requests are not retried, because a note write might already have completed. A client disconnect does not abort the sidecar fetch.

`MCP_RATE_LIMITER` allows 120 client registrations per 60 seconds per Cloudflare client IP. Authenticated `/mcp` forwarding has no application-level per-minute limit. Cloudflare rate limits are approximate and local to a Cloudflare location. Invocation logging is disabled because callback URLs contain codes and state; application logs use fixed events without tokens, email addresses, or request bodies.

Forwarding failures emit `mcp_forwarding_failure` with the failed layer, elapsed milliseconds, HTTP status when available, and sanitized exception details. These events cover VPC transport exceptions and upstream authentication or server errors. Tool-level errors returned in a successful MCP HTTP response are logged by the sidecar; the Worker streams that response without inspecting its body. From this package directory, use `npx wrangler tail --format json` to observe new Worker events, and inspect `joplin-headless-mcp` container logs on the VPS for backend request failures.

## Cloudflare resources

`PUBLIC_URL` in `wrangler.jsonc` is the public Worker origin and must stay `https://joplin-mcp.example.com` (without `/mcp`). Google OAuth uses this callback URL:

```text
https://joplin-mcp.example.com/oauth/google/callback
```

The resources are provisioned in the Cloudflare account configured by `account_id` in `wrangler.jsonc`. That file is the canonical source for their IDs.

| Resource | Worker binding | Name | Destination |
| --- | --- | --- | --- |
| KV namespace | `OAUTH_KV` | `joplin-mcp-oauth` | OAuth provider state and one-time transaction data |
| HTTP VPC Service | `JOPLIN_MCP` | `joplin-headless-mcp` | `localhost:41191` through the existing tunnel |

The VPC Service maps the Worker's fixed request URL `http://localhost:41191/mcp` to the MCP listener on the VPS loopback interface. Workers VPC requires the tunnel to use QUIC and `cloudflared` 2025.7.0 or later; the VPS was running version `2026.9.1` when checked. Outbound UDP port `7844` must be allowed. The sidecar needs no public DNS hostname, tunnel ingress rule, or reverse-proxy route. See Cloudflare's [Workers VPC tunnel requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/) and [VPC Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/).

If these resources need to be recreated, authenticate Wrangler to the configured account, then run the following commands from this package directory and put the returned IDs into the corresponding bindings in `wrangler.jsonc`:

```sh
npx wrangler kv namespace create joplin-mcp-oauth
npx wrangler vpc service create joplin-headless-mcp \
  --type http \
  --tunnel-id 00000000-0000-0000-0000-000000000000 \
  --hostname localhost \
  --http-port 41191
```

Creating a VPC Service requires the account's Connectivity Directory Admin permission; binding an existing VPC Service requires Connectivity Directory Bind. See the [Wrangler VPC Service command reference](https://developers.cloudflare.com/workers/wrangler/commands/vpc/).

The Google Cloud project `joplin-mcp-example` has an OAuth app branded `Joplin MCP`, with audience External and publishing status Testing. The `Joplin MCP Worker` web OAuth client uses the callback URL above. The Worker requests only the `openid`, `email`, and `profile` identity scopes. Google's guidance says test-user allowlisting and seven-day authorization expiry do not apply when an app requests only these scopes; see [Manage App Audience](https://support.google.com/cloud/answer/15549945?hl=en). The Worker also displays its own per-client consent page.

## Secrets and local development

Install SOPS locally and use a current supported Node.js release for tooling; this package requires Node.js 22 or later. Dependency versions are pinned in this package and its lockfile, independently of the parent repository.

The committed encrypted file `extras/cloudflare-mcp-worker/.sops.env` contains these Worker secrets:

| Secret | Value |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Google web application's client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google web application's client secret |
| `JOPLIN_MCP_BEARER_TOKEN` | Same token as the native deployment's `MCP_BEARER_TOKEN` |

The repository-root `.sops.yaml` selects the public age recipient for this file. From this package directory, create or edit the encrypted dotenv file:

```sh
sops edit .sops.env
```

Copy the matching MCP bearer token from the native deployment's SOPS editor into this Worker's SOPS editor. Keep the token values out of shell arguments, command history, and plaintext files. Keep the matching age private key private. SOPS uses `~/.config/sops/age/keys.txt` by default; set `SOPS_AGE_KEY_FILE` when your identity is stored elsewhere.

`npm run dev` decrypts the file to a temporary dotenv file and starts Wrangler with local HTTPS. The VPC binding is marked `remote: true`, so MCP forwarding depends on the provisioned Cloudflare VPC Service and account access. `npm run deploy` uploads the secrets and deploys the Worker; it is a live activation command.

## Local checks

From this directory:

```sh
npm ci
npm run types
npm run typecheck
npm test
npm run test:worker
```

`npm test` covers signed Google identity verification and fixed-destination forwarding. `npm run test:worker` builds with Wrangler's dry-run command and runs one representative flow in its bundled workerd runtime: registration, consent, Google PKCE/OIDC, client PKCE exchange, and authenticated MCP forwarding. It also checks missing browser cookies, callback replay, and a disallowed account. Google and sidecar responses are synthetic; no real credentials or external services are used. Local runtime checks require permission to open loopback sockets.

`npm run build` only bundles with `wrangler deploy --dry-run`; it does not deploy. For manual browser sign-in during local development, use HTTPS and keep `PUBLIC_URL` and the registered Google redirect URI aligned, because the provider uses Secure `__Host-` cookies. `npm run dev` starts Wrangler with HTTPS.

