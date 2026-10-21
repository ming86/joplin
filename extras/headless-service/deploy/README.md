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

Mount durable storage at `/data`; the core profile defaults to `/data/profile`. The native Quadlet setup maps the host directory `~/.local/share/joplin-headless` to `/data`. It must be owned by container UID 1000 with mode `0700`: Joplin creates its profile lock beside the profile, so the parent directory must also be writable. This local profile contains the SQLCipher-encrypted Joplin database and is separate from the PostgreSQL data used by a Joplin Server. Other profile files, including resource files, are not necessarily covered by SQLCipher encryption. Protect and back up the whole profile as sensitive data.

The core defaults to `/opt/headless-native/node_modules/sqlite3` for its native SQLite module. Supply its database key through `JOPLIN_HEADLESS_KEY_FILE`, which defaults to `/run/secrets/database-key`. The file must contain exactly 64 hexadecimal characters and may end with a newline. Keep it in a mode `0600` file owned by the service user, with ownership mapped to container UID 1000 for rootless Podman. The entrypoint opens it on file descriptor 3, removes the file path from its environment, and sets `JOPLIN_HEADLESS_KEY_FD=3`; the raw key is not passed in argv or an environment variable. The core needs the same key whenever it starts. Retain the original key in the encrypted SOPS source and include it in protected backups; losing it makes the local database unreadable.

## MCP configuration

Provide the MCP container with a private JSON config and separate private files for the core API token and MCP bearer token. The config and token files are mounted read-only from `~/.config/joplin-headless` and owned by container UID 1000. The config must be readable by the process, and both token files must be regular files with no group or other permissions, such as mode `0600`; the MCP loader checks these token-file permissions. The config file uses this HTTP setup:

```json
{
  "accountId": "personal",
  "baseUrl": "http://127.0.0.1:41190",
  "apiTokenFile": "/run/secrets/joplin-api-token",
  "allowWrites": false,
  "listenHost": "0.0.0.0",
  "listenPort": 41191,
  "bearerTokenFile": "/run/secrets/joplin-mcp-bearer",
  "allowedOrigins": []
}
```

Set the core profile's `api.port` to `41190` so it matches the MCP `baseUrl`. The MCP listener uses `0.0.0.0` inside the shared pod so Podman can publish its port on the VPS loopback interface. `allowedOrigins` is an exact allowlist for requests that include an `Origin` header; it does not authenticate clients. `allowWrites` is false in the generated config. No semantic-search configuration is required for this deployment. See [MCP.md](../MCP.md) for the full transport and configuration behavior.

## Health and deployment scope

`GET /healthz` is an unauthenticated liveness check: HTTP 200 means the MCP listener is running. `GET /readyz` probes the configured core account and returns 503 if the API cannot respond. A ready response does not show that synchronization or decryption has completed. The image has no supervisor; each container runs one selected role.

The container package documents the image contract. Configure service units, secret files and backups for the deployment environment.
