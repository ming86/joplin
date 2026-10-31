# Joplin MCP OAuth proxy

This Worker protects the public MCP endpoint with Google sign-in and OAuth. Only the verified Google address configured by `ALLOWED_GOOGLE_EMAIL` can receive a grant. The Worker forwards authenticated MCP requests through a Cloudflare Workers VPC Service to the private headless sidecar. The sidecar itself has no public hostname or HTTP route.

The package uses `@cloudflare/workers-oauth-provider` consent and upstream transaction helpers. They bind consent and Google callbacks to the initiating browser, with one-time transactions in KV. Google ID tokens are checked against Google's signing keys, issuer, client audience, expiry, nonce, and verified-email claim. Email comparison ignores case; it does not normalize Gmail dots or aliases. Google access and refresh tokens are not retained.

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

Forwarding always uses the VPC binding `JOPLIN_MCP` and the fixed URL `http://localhost:41191/mcp`. The VPC Service maps that request to `localhost:41191` through a Cloudflare Tunnel. The Worker preserves MCP version/method/name headers, content metadata, Accept, and Origin. It replaces the client's OAuth credential with `JOPLIN_MCP_BEARER_TOKEN`; client cookies and OAuth credentials are not sent to the sidecar. Responses stream with `Cache-Control: no-store`. Redirects are not followed and failed requests are not retried, because a note write might already have completed. A client disconnect does not abort the sidecar fetch.

`MCP_RATE_LIMITER` allows 120 client registrations per 60 seconds per Cloudflare client IP. Authenticated `/mcp` forwarding has no application-level per-minute limit. Cloudflare rate limits are approximate and local to a Cloudflare location. Invocation logging is disabled because callback URLs contain codes and state; application logs use fixed events without tokens, email addresses, or request bodies.

Forwarding failures emit `mcp_forwarding_failure` with the failed layer, elapsed milliseconds, HTTP status when available, and sanitized exception details. These events cover VPC transport exceptions and upstream authentication or server errors. Tool-level errors returned in a successful MCP HTTP response are logged by the sidecar; the Worker streams that response without inspecting its body. Before any manual Wrangler command from this package, run `npm run config:restore` to recreate the ignored local config. Then use `npx wrangler tail --config wrangler.local.jsonc --format json` to observe Worker events. Inspect the container logs on the host running the sidecar for backend request failures.

## Cloudflare and Google setup

The tracked `wrangler.jsonc` is a generic template. The tracked encrypted `wrangler.sops.json` contains the complete deployment configuration and uses the same age recipient as `.sops.env`. Restore it into the ignored, owner-only `wrangler.local.jsonc` from this package directory:

```sh
npm run config:restore
```

Edit the encrypted source with `sops edit wrangler.sops.json`; `npm run dev` and `npm run deploy` regenerate the ignored local file before running their existing SOPS `.sops.env` command. Changes made only to `wrangler.local.jsonc` are temporary because the next restore, development start, or deployment replaces them. If configuration decryption fails, the command stops and leaves the previous local file intact.

Keep the public origin in `PUBLIC_URL` as an origin without `/mcp`. The Google OAuth client must allow `${PUBLIC_URL}/oauth/google/callback` as a redirect URI. The Worker requests only the `openid`, `email`, and `profile` identity scopes.

`OAUTH_KV` stores OAuth provider state and one-time transaction data. `JOPLIN_MCP` binds to an HTTP VPC Service that reaches the sidecar at `localhost:41191` through a tunnel. To create the resources, use your local configuration and replace `TUNNEL_ID` with the tunnel you manage:

```sh
npx wrangler kv namespace create joplin-mcp-oauth --config wrangler.local.jsonc
npx wrangler vpc service create joplin-headless-mcp \
  --config wrangler.local.jsonc \
  --type http \
  --tunnel-id TUNNEL_ID \
  --hostname localhost \
  --http-port 41191
```

Save returned IDs in the corresponding bindings through `sops edit wrangler.sops.json`, then run `npm run config:restore` before further manual Wrangler commands. Creating a VPC Service requires the account's Connectivity Directory Admin permission; binding an existing VPC Service requires Connectivity Directory Bind. Workers VPC requires the tunnel to use QUIC and `cloudflared` 2025.7.0 or later. Outbound UDP port `7844` must be allowed. The sidecar needs no public DNS hostname, tunnel ingress rule, or reverse-proxy route. See Cloudflare's [Workers VPC tunnel requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/) and [VPC Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/), plus the [Wrangler VPC Service command reference](https://developers.cloudflare.com/workers/wrangler/commands/vpc/).

## Secrets and local development

Install SOPS locally and use Node.js 22 or later for tooling. Dependency versions are pinned in this package and its lockfile, independently of the parent repository.

The committed encrypted file `.sops.env` contains these Worker secrets:

| Secret | Value |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Google web application's client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google web application's client secret |
| `JOPLIN_MCP_BEARER_TOKEN` | Same token as the native deployment's `MCP_BEARER_TOKEN` |

The repository-root `.sops.yaml` selects the public age recipient for this file and for `wrangler.sops.json`. From this package directory, edit either encrypted source with SOPS:

```sh
sops edit .sops.env
sops edit wrangler.sops.json
```

Copy the matching MCP bearer token from the native deployment's SOPS editor into this Worker's SOPS editor. Keep the token values out of shell arguments, command history, and plaintext files. Keep the matching age private key private. SOPS uses `~/.config/sops/age/keys.txt` by default; set `SOPS_AGE_KEY_FILE` when your identity is stored elsewhere.

`npm run dev` restores `wrangler.local.jsonc`, decrypts `.sops.env` to a temporary dotenv file, and starts Wrangler with local HTTPS. The VPC binding is marked `remote: true`, so MCP forwarding depends on a provisioned Cloudflare VPC Service and account access. `npm run deploy` restores the same local config, uploads the secrets, and deploys the Worker.

The generic tracked `wrangler.jsonc` still supports `npm run types`, `npm run typecheck`, `npm test`, `npm run test:worker`, and `npm run build` without the age key.

For recovery on a fresh laptop, clone the repository, install Node.js 22 or later and SOPS, and restore the age identity from its independent backup (by default at `~/.config/sops/age/keys.txt`, or at the path set by `SOPS_AGE_KEY_FILE`). After installing dependencies with `npm ci`, run the normal package commands. The identity decrypts the configuration and secrets; Cloudflare account access and provisioned resources remain external prerequisites. For a full native-service redeployment, also recover its deployment scripts and encrypted settings, VPS access, and server data.

Someone configuring a separate deployment can create their own encrypted `wrangler.sops.json` from the generic `wrangler.jsonc` and encrypt it for their own age key.

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
