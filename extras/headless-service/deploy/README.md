# Headless service container

This directory packages the headless Joplin core and the HTTP MCP adapter in one OCI image. The image targets Linux/amd64 and uses Debian 13, Node.js 26.11.1, SQLCipher 4.19.0, and the native `sqlite3` module at `/opt/headless-native/node_modules/sqlite3`. Build it from the repository root:

```sh
docker buildx build --platform linux/amd64 --load \
  -f extras/headless-service/deploy/Containerfile \
  -t joplin-headless:local .
```

Dependency installation is cached separately from workspace sources. Source-only edits reuse the focused dependency layer. Changes to workspace manifests, the lockfile, Yarn configuration, releases or patches reinstall dependencies. The selected workspaces have no install hooks that require their source files; their explicit builds run after source copying. Build tools are installed before these copies so source edits also reuse that layer.

The image runs as UID 1000 under `tini`. Its entrypoint selects one of two roles:

| Role | Behavior |
| --- | --- |
| `core [command ...]` | Runs the Joplin CLI with the persistent profile. With no command it runs `serve`; commands such as `config`, `sync`, and `e2ee` are passed to the CLI. |
| `mcp [config-path]` | Runs the stateless HTTP MCP adapter. The default config path is `/etc/joplin-headless/mcp-http.json`. |

For example, the core and MCP adapter can run in separate containers that share a network namespace: MCP reaches the core Data API at `http://127.0.0.1:41190`. Keep the API private to the core and MCP roles. MCP listens on port `41191` inside its container; publish it only through a trusted ingress configured for the deployment.

This image builds the CLI dependency set for the headless API and synchronization path. It does not compile the optional Rust-based OneNote importer.

## Headless diagnostics

The core writes safe diagnostic records to stderr and `/data/profile/log-headless.txt` with mode `0600`. Inspect stderr through the container runtime's logging interface or read the file from the mounted profile. Records identify the operation and stage, recognized error codes and available HTTP statuses, fixed explanations, underlying causes and known source call sites. Status-acquisition failures identify whether disabled-item counting, account-profile lookup or live-state summarization failed; the public API keeps its generic error.

The core rotates this file before the next complete UTF-8 record would make a nonempty active file exceed 10 MiB. It retains three archives, `log-headless.1.txt` through `log-headless.3.txt`, with `.1` newest; normal retention is at most about 40 MiB including the active file. The active file and retained archives have mode `0600`. Rotation shares the logger's ordered write queue and preserves archives across restarts. A preexisting oversized file or one oversized record stays intact until it ages out of the three archives. The container runtime manages stderr retention separately.

The shared Joplin library and Clipper loggers remain disabled because they can log request tokens, credentials or note content. Diagnostic records never forward their raw error objects or response text. Unknown error codes and messages receive an explicit fallback explanation; HTTP status appears only when the underlying error retains it. A Joplin Server `invalidOrigin` code can replace its original numeric HTTP status, so the code and fixed origin explanation may appear without a status number.

Background synchronization supplies an optional error observer at the existing native catch points. This records failures that Joplin handles internally, including temporary network errors omitted from the progress report and report-only item/publication failures. Scheduling failures also retain their original causes. Successful polls produce no new diagnostic entries, and `changedDuringSync` remains a quiet retry condition. Callers that do not supply the observer retain their existing behavior.

Headless CLI sync and decryption failures exit nonzero. The native bootstrap helper labels import, sync, decrypt and informational encryption-status stages, stops at the failing stage, and prints completion only when every command succeeds. Successful import still removes the plaintext settings copy before synchronization. This changes failure reporting, not background scheduling, retry behavior or attachment-download policy.

## Core profile and key

Mount durable storage at `/data`; the core profile defaults to `/data/profile`. The profile directory must be writable by container UID 1000 and use mode `0700`: Joplin creates its profile lock beside the profile, so the parent directory must also be writable. This local profile contains the SQLCipher-encrypted Joplin database and is separate from any PostgreSQL data used by a Joplin Server. Other profile files, including resource files, are not necessarily covered by SQLCipher encryption. Protect the profile as sensitive data.

The core defaults to `/opt/headless-native/node_modules/sqlite3` for its native SQLite module. Supply its database key through `JOPLIN_HEADLESS_KEY_FILE`, which defaults to `/run/secrets/database-key`. The file must contain exactly 64 hexadecimal characters and may end with a newline. Mount a mode `0600` key file that container UID 1000 can read. The entrypoint opens it on file descriptor 3, removes the file path from its environment, and sets `JOPLIN_HEADLESS_KEY_FD=3`; the raw key is not passed in argv or an environment variable. The core needs the same key whenever it starts. Protect the key and retain it with the encrypted profile's recovery material; losing it makes the local database unreadable.

For private Joplin Server sync, configure `sync.9.path` with the server URL reachable from the core container. If that address differs from the server's configured origin, `sync.9.headlessHost` supplies the expected HTTP Host for headless sync target 9. This override applies only to the headless profile; normal clients use the default empty override. Deployment tooling may render these settings from inputs such as `JOPLIN_SERVER_URL` and `JOPLIN_SERVER_HOST`; those names are deployment inputs, not environment variables consumed by the image entrypoint.

While `core serve` is running, `JOPLIN_HEADLESS_SYNC_INTERVAL` sets the delay between lightweight remote polls; its default is `15` seconds. A remote poll is scheduled after that delay from the previous poll's completion, including after a failure. Polling pauses while a full sync runs, then waits a fresh poll interval after it finishes. A periodic full sync is scheduled `120` seconds after the previous periodic full sync finishes, whether it succeeds or fails. The remote poll uses Joplin's synchronizer and saved delta cursor, including its usual metadata, E2EE, and shared-item preparation. When the server reports no changes and preparation has not created local changes, the poll saves the returned cursor and skips costly outgoing scans. Otherwise, it follows normal reconciliation. The standard `sync.interval` setting continues to control normal clients. Local saves keep the one-second debounce, and edits committed during an active run receive a follow-up after it ends. Sync runs do not overlap, and active work can delay a scheduled request. Download concurrency and attachment-download policy are configured separately.

## Semantic index

An MCP configuration can use a compatible embeddings endpoint and model. The OVMS Granite example, `granite-embedding-311m-multilingual-r2`, uses a fixed 384-dimensional space and L2 normalization. The revision is an operator label for the configured space, not a verified model-weights hash. Set the separate SQLCipher store path in the MCP configuration under persistent storage at `/data/semantic`. Its directory must use mode `0700` and be writable by container UID 1000. When the core and MCP run in separate containers, make the semantic directory available to MCP at the configured path.

The semantic worker reads the local core event feed every five seconds. This uses the core's event API and does not run Joplin synchronization every five seconds. Current source scan and repair behavior is described in [the semantic index guide](../docs/semantic.md#persisted-data-and-indexing). The core's independent remote-poll interval is configurable, and periodic full syncs use the 120-second completion-based delay described above.

Supply the semantic database key and embedding provider credential as private runtime secrets, mounted read-only into MCP. Use `get_status` to inspect index state; `/readyz` reports core/MCP connectivity and does not mean the semantic index is ready.

## MCP configuration

Provide the MCP container with a private JSON config and separate private files for the core API token and MCP bearer token. Mount the config and token files read-only and make them readable by container UID 1000. The config must be readable by the process, and both token files must be regular files with no group or other permissions, such as mode `0600`; the MCP loader checks these token-file permissions. The following is an HTTP configuration example:

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

Set the core profile's `api.port` to the port used by the MCP `baseUrl`. When core and MCP run in separate containers, connect them on a private network and restrict access to the core API. The MCP listener can bind to `0.0.0.0` inside its container so the container runtime can publish it through the chosen ingress. `allowedOrigins` is an exact allowlist for requests that include an `Origin` header; it does not authenticate clients. This example config sets `allowWrites` to true. This source version exposes 32 tools (19 read tools and 13 write tools), including revision-protected contextual note patches, individual and combined native revision history, notebook/tag maintenance, attachments and file transfer, conflict inspection, Trash restoration, attachment-reference lookup, grep/source-line reads, and semantic chunk search. Both role containers must use the same image for native operations such as `list_revisions` and revision-protected `body_patch` updates. `semantic_search_notes` returns full reconstructed matching chunks, and a note can contribute multiple ranked rows. It accepts one optional notebook or tag scope and a model-specific `strict`, `normal` or `loose` relevance preset. With no semantic backend configured it returns `semantic_unavailable`; startup, query and provider failures retain their service error codes instead of returning fabricated matches. `search_notes` remains note-row search and keeps its existing semantic status and hybrid keyword-fallback behavior. See [mcp.md](../docs/mcp.md) and [semantic.md](../docs/semantic.md) for the full transport and retrieval behavior.

## Health and deployment scope

`GET /healthz` is an unauthenticated liveness check: HTTP 200 means the MCP listener is running. `GET /readyz` probes the configured core account and returns 503 if the API cannot respond. A ready response does not show that synchronization or decryption has completed. The image has no supervisor; each container runs one selected role.

This guide documents the image and runtime contract. Host-specific service units, secret provisioning and backup procedures belong in the deployment repository.
