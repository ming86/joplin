# Headless service container

This directory packages the headless Joplin core and the HTTP MCP adapter in one OCI image. The image targets Linux/amd64 and uses Debian 13, Node.js 26.11.1, SQLCipher 4.19.0, and the native `sqlite3` module at `/opt/headless-native/node_modules/sqlite3`. Build it from the repository root:

```sh
docker buildx build --platform linux/amd64 --load \
  -f extras/headless-service/deploy/Containerfile \
  -t joplin-headless:local .
```

The image runs as UID 1000 under `tini`. Its entrypoint selects one of two roles:

| Role | Behavior |
| --- | --- |
| `core [command ...]` | Runs the Joplin CLI with the persistent profile. With no command it runs `serve`; commands such as `config`, `sync`, and `e2ee` are passed to the CLI. |
| `mcp [config-path]` | Runs the stateless HTTP MCP adapter. The default config path is `/etc/joplin-headless/mcp-http.json`. |

The core and MCP adapter run as separate containers in one rootless Podman pod and share its network namespace. The core Data API listens on port `41190`; MCP connects to `http://127.0.0.1:41190`. Keep that API private to the pod. MCP listens on port `41191` inside the pod, and the VPS publishes it only at `127.0.0.1:41191`. The existing Cloudflare Tunnel can then reach that loopback listener for the Workers VPC Service without a public sidecar hostname, tunnel ingress rule, or reverse-proxy route.

This image builds the CLI dependency set for the headless API and synchronization path. It does not compile the optional Rust-based OneNote importer.

## Core profile and key

Mount durable storage at `/data`; the core profile defaults to `/data/profile`. The native Quadlet setup maps the host directory `~/.local/share/joplin-headless` to `/data`. It must be owned by container UID 1000 with mode `0700`: Joplin creates its profile lock beside the profile, so the parent directory must also be writable. This local profile contains the SQLCipher-encrypted Joplin database and is separate from the PostgreSQL data used by a Joplin Server. Other profile files, including resource files, are not necessarily covered by SQLCipher encryption. Protect the profile as sensitive data.

The core defaults to `/opt/headless-native/node_modules/sqlite3` for its native SQLite module. Supply its database key through `JOPLIN_HEADLESS_KEY_FILE`, which defaults to `/run/secrets/database-key`. The file must contain exactly 64 hexadecimal characters and may end with a newline. Keep it in a mode `0600` file owned by the service user, with ownership mapped to container UID 1000 for rootless Podman. The entrypoint opens it on file descriptor 3, removes the file path from its environment, and sets `JOPLIN_HEADLESS_KEY_FD=3`; the raw key is not passed in argv or an environment variable. The core needs the same key whenever it starts. Retain the original key in the encrypted SOPS source and include it in protected backups; losing it makes the local database unreadable.

For private Joplin Server sync, `JOPLIN_SERVER_URL=http://joplin-server:22300` can select the TCP destination on the Podman network. The encrypted settings also carry the non-secret HTTP host label `JOPLIN_SERVER_HOST=joplin.example.com`; the renderer imports it as `sync.9.headlessHost` to satisfy the existing Joplin Server origin check for headless sync target 9. This host override applies only to the headless profile; normal clients use the default empty override. Joplin sync does not use an internet or cloudflared route. The separate MCP connection reaches the Worker through Workers VPC.

While `core serve` is running, `JOPLIN_HEADLESS_SYNC_INTERVAL` sets the delay between lightweight remote polls. Its default is `15` seconds, and the native Quadlet can set it to `20` seconds. A remote poll is scheduled after that delay from the previous poll's completion, including after a failure. Polling pauses while a full sync runs, then waits a fresh `20` seconds after it finishes. A periodic full sync is scheduled `120` seconds after the previous periodic full sync finishes, whether it succeeds or fails. The remote poll uses Joplin's synchronizer and saved delta cursor, including its usual metadata, E2EE, and shared-item preparation. When the server reports no changes and preparation has not created local changes, the poll saves the returned cursor and skips costly outgoing scans. Otherwise, it follows normal reconciliation. The standard `sync.interval` setting continues to control normal clients; the renderer can retain its supported value of `300`. Local saves keep the one-second debounce, and edits committed during an active run receive a follow-up after it ends. Sync runs do not overlap, and active work can delay a scheduled request. The ten-connection download setting and manual attachment-download policy remain separate.

## Semantic index

An MCP configuration can use an OVMS Granite endpoint such as `http://embedding-service:9000/v1`, model `granite-embedding-311m-multilingual-r2`, a fixed 384-dimensional space and L2 normalization. The revision is an operator label for the configured space, not a verified model-weights hash. The store path is `/data/semantic/personal.sqlite`; its containing `~/.local/share/joplin-headless/semantic` directory is mode `0700` and owned by container UID 1000. The core’s existing `/data` mount includes this directory. MCP mounts the semantic subdirectory writable at `/data/semantic`.

The semantic worker reads the local core event feed every five seconds and starts full content reconciliation 30 minutes after the previous reconciliation completes. The local check reads the core's event API; it does not run Joplin synchronization every five seconds. The existing core schedule remains a 20-second remote-change poll and a 120-second periodic full sync, both completion-based.

The encrypted native `.sops.env` contains a separate `SEMANTIC_DATABASE_KEY` and a copy of the current Granite `API_KEY` as `OVMS_API_KEY`. The renderer creates owner-only `semantic-database-key` and `ovms-embedding-api-token` files and mounts both read-only into MCP. The Granite token's encrypted source is the OVMS deployment; update both encrypted copies when the shared token rotates. Use `get_status` to inspect index state; `/readyz` reports core/MCP connectivity and does not mean the semantic index is ready.

## MCP configuration

Provide the MCP container with a private JSON config and separate private files for the core API token and MCP bearer token. The config and token files are mounted read-only from `~/.config/joplin-headless` and owned by container UID 1000. The config must be readable by the process, and both token files must be regular files with no group or other permissions, such as mode `0600`; the MCP loader checks these token-file permissions. The config file uses this HTTP setup:

```json
{
  "accountId": "personal",
  "baseUrl": "http://127.0.0.1:41190",
  "apiTokenFile": "/run/secrets/joplin-api-token",
  "allowWrites": true,
  "listenHost": "0.0.0.0",
  "listenPort": 41191,
  "bearerTokenFile": "/run/secrets/joplin-mcp-bearer",
  "allowedOrigins": []
}
```

Set the core profile's `api.port` to `41190` so it matches the MCP `baseUrl`. The MCP listener uses `0.0.0.0` inside the shared pod so Podman can publish its port on the VPS loopback interface. `allowedOrigins` is an exact allowlist for requests that include an `Origin` header; it does not authenticate clients. The generated config sets `allowWrites` to true. The current catalog exposes 31 tools (18 read tools and 13 write tools), including native revisions, notebook/tag maintenance, attachments and file transfer, conflict inspection, Trash restoration, attachment-reference lookup, grep/source-line reads, and semantic chunk search. `semantic_search_notes` returns full reconstructed matching chunks, and a note can contribute multiple ranked rows. It accepts one optional notebook or tag scope and a model-specific `strict`, `normal` or `loose` relevance preset. With no semantic backend configured it returns `semantic_unavailable`; startup, query and provider failures retain their service error codes instead of returning fabricated matches. `search_notes` remains note-row search and keeps its existing semantic status and hybrid keyword-fallback behavior. See [MCP.md](../MCP.md) and [SEMANTIC.md](../SEMANTIC.md) for the full transport and retrieval behavior.

## Health and deployment scope

`GET /healthz` is an unauthenticated liveness check: HTTP 200 means the MCP listener is running. `GET /readyz` probes the configured core account and returns 503 if the API cannot respond. A ready response does not show that synchronization or decryption has completed. The image has no supervisor; each container runs one selected role.

The container package documents the image contract. Configure service units, secret files and backups for the deployment environment.
