# Joplin headless service

This implementation has two connected parts: changes in Joplin's native headless CLI/core under `packages/app-cli` and `packages/lib`, and the account-bound service and launchers under `extras/headless-service`. The external service talks to the core's private Data API; native code owns the profile, synchronization and revision-guarded note update. The service package can also be imported as a library, but its lower-level mutation methods do not all provide the MCP revision guarantee described below.

## Where the headless work lives

Preserve Joplin's upstream monorepo layout and existing application behavior. The headless service reuses Joplin's native synchronization, E2EE, and data models instead of building parallel implementations. Service features and adapters live in `extras/headless-service`; `extras/cloudflare-mcp-worker` remains a separate project. Keeping native patches in `packages/app-cli` and `packages/lib` small and focused makes it easier to bring future upstream changes into this fork. A native change is appropriate when the existing API cannot correctly meet a requirement, such as the atomic revision guard for MCP note updates.

The external JavaScript adapters require Node 22.12 or newer and use Node built-ins without third-party adapter dependencies. The native core still needs its normal built runtime and dependencies.

## Current behavior

The native headless core runs synchronization without overlapping runs. It schedules a remote-change poll after the configured delay from the previous poll's completion, including after failure; polls pause during a full sync and resume after a fresh delay. `JOPLIN_HEADLESS_SYNC_INTERVAL` defaults to 15 seconds and can be set to 20 seconds. A periodic full sync starts 120 seconds after the prior periodic full sync settles. Local changes use Joplin's approximately one-second as-you-type delay. Edits made during active synchronization get a follow-up run, and active work can delay a scheduled request. See [the container and runtime notes](deploy/README.md) for configuration.

With writes enabled, `tools/list` exposes 32 MCP tools: 19 read tools and 13 write tools. The read count includes the backwards-compatible `get_note` alias. Writes are disabled by default. The catalog covers note and notebook operations, native note history for individual notes or combined note/notebook scopes, conflict and Trash inspection, attachment upload and reading, attachment-reference lookup, source-line search, tag maintenance, and semantic chunk search.

For MCP note edits, `read_note` or `grep_notes` returns the native `revision_id`; `update_note` requires it as `base_revision_id`. The core checks that revision and saves the update with before/after native revisions in one atomic operation. If the note changed first, the edit returns `note_conflict` without applying the stale change. This guarantee belongs to the MCP `update_note` path. The lower-level account-library `updateNote` performs a best-effort eligibility read and then an ordinary update; it does not compare a supplied revision atomically. Do not treat every library mutation as revision guarded.

Notes can be read inline, as metadata, or as an embedded UTF-8 file resource. File input supports full note creation or replacement; attachment tools read and upload binary files. `grep_notes` searches exact source lines, and `read_note` accepts inclusive logical line ranges. `list_attachment_notes` scans current saved note bodies, including Trash and conflict copies, to find attachment references. Trash listing and restore, notebook subtree restore, and conflict inspection are available through MCP. Full schemas and behavior are in [mcp.md](docs/mcp.md).

`search_notes` returns note rows in keyword, semantic, or hybrid mode. The separate `semantic_search_notes` tool returns ranked matching chunks, so a note can appear more than once; each row includes the full chunk text and its score. It accepts one optional notebook or tag scope and a `strict`, `normal`, or `loose` relevance preset. Use `read_note` to open the complete note for context. If the semantic engine or embedding provider is unavailable, the dedicated tool returns a clear MCP error. `search_notes` keeps its existing semantic status and hybrid keyword-fallback behavior.

Semantic configuration selects an embedding provider, model and compatible derived index. The semantic worker reads the local Joplin event feed every five seconds and processes persisted note changes and retries. It runs a full content scan for initial or incomplete indexing, when the current feed head is behind the saved cursor, or for explicit offline repair; routine event processing does not schedule a full scan. These local event checks are separate from remote synchronization. Use `get_status` to inspect the configured account's current indexing state. The [semantic guide](docs/semantic.md) describes configuration and validation limits; the [container guide](deploy/README.md#health-and-deployment-scope) distinguishes connectivity checks from indexing, synchronization and decryption status. Deployment-specific counts and release records belong with the deployment configuration.

## Account and data boundaries

The library's `createAccountRegistry(configurations)` binds each configured account to explicit subjects and read/write permissions. Callers must pass an identity already verified by their own authentication layer to `forPrincipal(verifiedSubject, accountId)`; this library is not an authenticator or network server. Account selection and grants come from trusted startup configuration, not MCP arguments. Unknown and unauthorized accounts return the same error, and backend factories run only after account resolution.

The configured Joplin API token retains its upstream permissions. The service's read/write checks constrain its own methods and MCP catalog; they do not narrow the raw private Data API credential. Keep that API private. Stdio and HTTP launchers bind to one configured account. Managed deployments can run separate workers for multiple accounts; they do not make one Joplin core load several profiles. See [multi-user.md](docs/multi-user.md).

Ordinary note reads and search omit encrypted, trashed and locked notes. Trash listing includes deleted notes and notebooks, with encrypted titles masked. Attachment-reference lookup includes Trash and conflict copies but excludes encrypted and locked notes. Paginated lists are not transactional snapshots.

Note-body edits preserve the existing Markdown or HTML format. To-do due times are integer Unix epoch milliseconds, with `0` clearing the due time. Source provenance fields are read-only; `source_url` can be changed. `body_total_line_count` counts CRLF, LF and lone CR as one line break, includes the final empty line after a trailing break, and counts an empty body as one line.

## Account-bound service library

A trusted application can create one or more account bindings and resolve them after authenticating its caller:

```js
import { createAccountRegistry } from './index.mjs';

const registry = createAccountRegistry([{
    id: 'personal',
    subjects: ['verified-auth-subject'],
    permissions: ['read'],
    joplin: { baseUrl: 'http://127.0.0.1:41184/', token: apiTokenFromProtectedSource },
    semantic: { databasePath: '/data/semantic/personal.db', keyRef: 'personal/semantic-key' },
}]);
const account = registry.forPrincipal(authenticatedSubject, 'personal');
const result = await account.search({ query: 'postgres replication', mode: 'keyword' });
```

The registry copies startup configuration and rejects duplicate account, endpoint, semantic-store path and key-reference bindings. `semantic.databasePath` and `keyRef` identify the optional derived store; constructing the registry alone does not open it. The MCP launchers load their own JSON configuration and optional semantic runtime. See [mcp.md](docs/mcp.md) and [semantic.md](docs/semantic.md) for those formats.

The library's `account.createNote` retains the generic Data API creation path. MCP `create_note` instead calls `createNoteWithRevision`, which commits the new note and its initial native revision atomically. Library consumers must select the revision-aware method when they need that guarantee; an ordinary Data API create is not equivalent.

## MCP transports

`mcp.mjs` provides stdio MCP. `mcp-http.mjs` provides stateless HTTP MCP with a private bearer credential; it defaults to loopback. Neither launcher starts the Joplin core, opens its database, or needs the core DB key or E2EE password. Configure the launcher with the existing private Data API endpoint and token. Both transports are read-only by default; writes require operator configuration. See [mcp.md](docs/mcp.md) for configuration, tool contracts, protocol behavior and smoke commands.

Related entry points are `fleet.mjs` for managed account workers, `web.mjs` for the browser interface, and `clipper.mjs` for selected-text capture. Their boundaries and setup are documented in [multi-user.md](docs/multi-user.md), [web.md](docs/web.md), and [clipping.md](docs/clipping.md). The deferred browser, device, HTTPS and installation observations remain scoped in [backlog.md](backlog.md); they are not prerequisites for the managed-account implementation.

## Local checks

These commands are available from the repository root. They are instructions for running checks, not a record that they were run for this documentation update.

```sh
node --test extras/headless-service/tests/*.test.mjs
python3 extras/headless-service/tests/schema_test.py
# Optional consumer declaration check with an explicitly selected TypeScript compiler:
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext \
  extras/headless-service/tests/types.test.mts
```

The Python schema test uses ordinary in-memory SQLite to check relational constraints and rollback; it does not test encryption or a running index. Native integration tests require the built Joplin runtime and their documented environment variables.

For an already running core, `scripts/check-account.mjs` performs read-only account, keyword-search and change-cursor checks, confirms explicit semantic unavailability, and exercises an in-memory fake embedding provider. Its private config must be based on [scripts/account-smoke.example.json](scripts/account-smoke.example.json) and include an existing synthetic test note ID and matching query:

```sh
node extras/headless-service/scripts/check-account.mjs /private/account-smoke.json
```

The MCP wire smoke initializes the stdio adapter, checks discovery/status/list operations, and optionally reads a supplied note and verifies a supplied keyword query. It makes no writes or model calls:

```sh
node extras/headless-service/scripts/check-mcp.mjs /private/mcp.json [NOTE_ID] [QUERY]
```

The reference smoke client is not the official MCP SDK and does not certify every host. These checks do not replace the native tests for core integration.
