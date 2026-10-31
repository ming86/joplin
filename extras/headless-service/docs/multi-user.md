# Managed independent accounts

This increment operates a small, fixed Linux deployment using the existing
account interfaces. It does not make one Joplin process load multiple profiles.
Each configured account has a separate application worker, one child Joplin core,
and optionally one SQLCipher semantic runtime. The web, clipper and all connected
MCP clients for that account reuse these instances.

## Boundary and routing

An account is selected by a trusted operator configuration, not by a browser parameter, MCP tool argument or global current-user variable. Each account gets its own web origin/listener, clipping listener and credentials, MCP Unix socket and credential, core endpoint/token, independent profile/DB key, and semantic path/key/reference. A single shared login site is not added. This is the manually provisioned deployment described by the roadmap, not a self-service account system.

The existing web login exchanges the account's web access key for an ephemeral
HttpOnly session. The clipper still uses its separate notebook-restricted bearer.
The new `mcp-connect.mjs` bridge authenticates to that account's owner-only Unix
socket, then forwards the existing tools-only stdio protocol. Several MCP hosts
can connect without starting several owners of the same semantic database.
Closing one MCP connection does not stop the account or other clients.

Web cookie names are account-scoped in managed mode; legacy `web.mjs` retains its
original default. This prevents sibling loopback ports from overwriting each
other's sessions. Cookies are **not** confidential between ports of the same
host. All loopback services in that topology must be trusted. Use distinct
HTTPS hostnames and the existing host-only Secure cookie policy for deployment,
not mutually untrusted applications on different ports of one hostname.
The actual ingress/device/install checks are [backlogged](../backlog.md).

All interfaces remain allowlisted. Account A's credentials are rejected at B's
endpoint. A guessed B note ID is looked up only in A's core; identical IDs in two
accounts refer to each account's own copy. Shared Joplin notebooks are still
independently synchronized/indexed according to the respective Joplin account's
access. Nothing bypasses those accounts by reading a global note index.

The operator and processes running as the service's Unix UID are trusted. This is application/account isolation, not a sandbox against a compromised worker, root, or hostile code executing under the same UID. Deployment tooling can add CPU/memory quotas and stronger host/container isolation; the service does not implement them. Providers may be shared by deliberate configuration, but semantic stores must not be. Configuring both profiles to sync the same Joplin identity intentionally gives both that identity's notes; the gateway cannot infer that the operator intended different identities from API tokens alone.

## Files and prerequisites

Use the already built CLI and SQLCipher binding; no dependency install, core format change, model download or E2EE reset is needed for this increment. The account files and secret references must be absolute paths. Managed configs and secrets are regular files, owned by the service UID, with mode `0600` (or stricter). Secret symlinks are refused. Control/socket directories are owned by the service UID with mode `0700`, sockets `0600`. These modes restrict file access; they do not require encrypting every config, static asset or the filesystem.

Start with `scripts/fleet.example.json`, `scripts/fleet-account.example.json` and
the existing MCP/semantic configuration. Copy the account example for the second
account and allocate distinct ports, web origins, stable 32-hex namespaces, paths
and independent credentials. A read-only account omits `clipper` and sets
`allowWrites: false` in its backend configuration. Any interface can be omitted,
but at least one must be enabled.

The DB key reference points to a **previously generated and retained** 64-hex key supplied by an external recovery/secret source, for example an owner-only file in a separately populated `/run/secrets` mount. Do not store unlock files inside profiles or include them in data backups/return packages. Merely writing a key alongside an encrypted DB on durable disk does not provide the intended stopped-storage protection. A platform secret manager is optional. The operator chooses how to populate the owner-only runtime files.

The supervisor hashes available secret values to reject reuse across accounts
and active generations. It therefore transiently reads those credentials; it
stores only non-secret configuration and disabled-state metadata. DB-key bytes
are not placed in child argv/environment: each core receives its own opened
file as inherited FD 3. The same key must be provided on later starts. Missing
or invalid material prevents that account from starting, not the other accounts.
Removing a key file does not revoke an already-running unlocked process; use
`disable` to revoke access and stop it.

## Provision an account without replacing its E2EE identity

A newly added account requires its own dedicated profile and DB key. Its Joplin
credentials and existing E2EE password come from that account's owner, not from
a gateway login or Joplin Server administrator credential. Do not copy account
A's credentials/keys to obtain a supposedly independent B account.

The explicit setup wrapper preserves stdin and the terminal for upstream import
and existing-key password prompts:

```sh
# Run only while this account is stopped and no other CLI owns its profile.
node extras/headless-service/account-core.mjs /private/alice.json import-config
node extras/headless-service/account-core.mjs /private/alice.json sync
node extras/headless-service/account-core.mjs /private/alice.json decrypt
node extras/headless-service/account-core.mjs /private/alice.json status
```

`import-config` is exactly `config --import`; supply its JSON through stdin from a controlled source, with the intended sync target/credentials, matching `api.port` and `api.token`. See the existing [headless setup guide](../../../readme/dev/headless-client.md). Do not put passwords in arguments, shell history, logs or an ordinary file. `sync` and `decrypt` are initial account setup, not periodic service commands. The wrapper has no default profile, `e2ee enable`, reset, key-generation, export, profile-copy or delete command. The core's existing profile lock still applies. Stock CLI output during explicit setup is operator-visible; do not upload raw output containing private account data. The background supervisor discards raw core output and reads only the fixed API-ready marker.

For an already configured Phase 4 account, retain its profile, keys, API token,
semantic database/configuration and retry namespaces. Stop its old standalone
web/MCP/clipper owners and core deliberately before transferring ownership.
Do not re-run provisioning or clone/change keys to adopt it. The initial Phase 5
acceptance should use two approved disposable accounts instead of disrupting the
existing personal runtime. No private profile is included in this source delivery.

## Run and control

```sh
node extras/headless-service/fleet.mjs /private/fleet.json

# Separate terminal, same trusted service UID:
node extras/headless-service/fleetctl.mjs /run/joplin-fleet/control.sock status
node extras/headless-service/fleetctl.mjs /run/joplin-fleet/control.sock restart alice
node extras/headless-service/fleetctl.mjs /run/joplin-fleet/control.sock disable alice
node extras/headless-service/fleetctl.mjs /run/joplin-fleet/control.sock enable alice
```

`status`, `start`, `stop`, `restart`, `disable` and `enable` are the only operator
commands. No operator HTTP endpoint is exposed. `status` reports each account's
starting/running/failed/retry-wait/stopped/disabled state and child PIDs, without
keys, tokens, bodies or downstream diagnostics. Running means that the account's
listeners started after an authenticated core read; it does **not** mean sync or
semantic indexing is complete. Check the existing authenticated web/MCP status
for semantic availability. Keyword access still works if semantic startup fails.

`stop` is temporary: an enabled account starts again at the next fleet start.
`disable` is durable in `stateDir/access.json`, is persisted before cancellation,
invalidates access by stopping that account's web/clipper/MCP listeners and core,
and survives supervisor restart. It does not delete data or rotate credentials.
The command acknowledges after stopping; already accepted writes can complete
during draining and are not rolled back. Re-enable uses the retained profile,
keys and credentials; users authenticate again because old sessions/connections
are gone. Enabling does not resurrect an old session cookie.

`restart` changes only the selected account. Credential contents can be rotated
in their existing external files, then that account restarted; all loaded
sessions/MCP connections are invalidated. Namespace/profile/endpoint/config
changes require restarting the fleet so cross-account bindings are revalidated.
The fleet rejects managed account configurations with `semantic.rebuild: true`. Perform an intentional index migration separately, while its owner is stopped, using the established semantic procedure, then restore normal `rebuild: false` configuration.

A core crash closes its account interfaces and triggers bounded account-local
restart (default three cumulative automatic attempts, exponential delay capped
at 30 seconds). A manual start/restart resets the counter. Missing secrets fail
that start directly rather than prompting or generating keys. One account's
startup failure does not prevent other accounts from becoming usable.

Shutdown drains web/clipper/MCP, closes the semantic runtime, then stops the core. There are bounded forced-termination fallbacks; a stopped state does not guarantee a clean SQLCipher checkpoint. Use the core's normal recovery and backup procedure. The supervisor reaps the account process group if its application worker dies; loss of the supervisor's IPC connection asks surviving workers to close their core. Use a normal host service manager/process group for host-level containment. No custom process supervisor can guarantee graceful cleanup after a host crash.

A hard kill may leave `fleet.lock`, a control socket or an account MCP socket.
These paths are **not automatically unlinked or taken over**. Before removing
only stale control/socket entries, verify the matching processes/listeners and
profile owner are stopped. A PID written in a file alone is not proof of current
ownership. Never delete `access.json`, the profile, index, keys or native profile
lease as a shortcut. This fail-closed recovery can require an explicit operator
step after SIGKILL; automatic restart is not promised for every crash shape.

## Connect MCP

A host uses only this account's connection file:

```json
{
  "socketPath": "/run/joplin-accounts/alice/mcp.sock",
  "tokenFile": "/run/secrets/alice-mcp"
}
```

```sh
node extras/headless-service/mcp-connect.mjs /private/alice-mcp-connection.json
```

Configure that command in the MCP host instead of starting `mcp.mjs` against the
same index. The bridge does not open a profile/index or know the DB/E2EE key. The
handshake is local transport authentication, not a new public MCP protocol or
remote OAuth endpoint. All existing protocol/tool limits remain in [mcp.md](mcp.md).
Remote stdio transport, operator permissions and credential provisioning must be
configured deliberately; this increment does not deploy a public MCP listener.

## Tests and acceptance

`tests/fleet.test.mjs` exercises actual supervisor/account/core subprocesses, web/clipper HTTP and authenticated MCP bridge processes against explicitly simulated, persistent synthetic cores. It tests cross-account rejection, identical IDs, independent writes/restarts, key failure, cookie isolation, revoke/re-enable, credential rotation, core/worker crashes and parent disconnect. Those fixture files are ordinary JSON, **not encrypted Joplin databases**. Existing native SQLCipher test results are reported separately from these fixture test results.

**Manual two-account acceptance checks passed on 2026-09-21.** The final entries in the local reports `INTERFACE-RESULTS.md`, `LIFECYCLE-RESULTS.md`, and `STOCK-RECEIPT-RESULTS.md` record per-account web, clipper, and MCP writes and isolation; keyword, semantic, and hybrid retrieval; independent restart; missing-key fail-closed behavior and recovery; durable disable/re-enable; and separate normal-mode stock-client sync, existing-key decryption, and plaintext reads of each account's synthetic note. The stock receipt used a separately built unmodified Joplin client. This targeted run used disposable accounts and synthetic data; it does not establish behavior for other accounts or content, deployed ingress, physical devices, locked-note UI, or PWA installation.

The interface run initially hit a semantic-index propagation delay after a write. Its final checks passed after the acceptance runner used a bounded post-write wait; earlier failures remain recorded in `INTERFACE-RESULTS.md`. A `ready` state with zero pending items alone can predate the semantic poll that notices a newly written note, so allow propagation before asserting search results.

The four intentionally deferred observations remain in [backlog.md](../backlog.md). They are outside the passed local two-account acceptance.

Primary runtime references checked for this implementation: Node v22.16.0
child_process (extra descriptors, IPC, process groups), net (Unix sockets), fs
(file flags/modes), and RFC 6265 section 8.5 (cookies do not isolate by port).
