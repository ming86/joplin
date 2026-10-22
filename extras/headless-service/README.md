# Account-bound Joplin application interface (Phase 1.5)

This is a small **external application library**, co-located in the repository for this delivery. It imports no Joplin internals and changes no CLI code. It can be moved to a separate application repository unchanged. `extras/` is outside the existing `packages/*` Yarn workspaces; no root dependency or lockfile modification is required. Runtime: Node 22.12 or newer; zero third-party dependencies. The explicit TypeScript declarations describe the JavaScript interface.

## Current behavior

The trusted application constructs `createAccountRegistry(configurations)`, authenticates a caller, then resolves `forPrincipal(verifiedSubject, accountId)`. Resolution checks an explicit grant before any backend/provider factory runs. Unknown and unauthorized accounts have the same error. Each account has independent Joplin endpoint/token, planned semantic-store location and key reference, and embedding deployment/space configuration. Duplicate account/store/key-reference/endpoint bindings are rejected. Configuration is copied, not used as shared mutable request state.

**This is not an authenticator or a network server.** Never fill `verifiedSubject` from an unverified request or MCP tool argument. The configured Joplin API credential still has broad upstream powers. Read/write permissions here constrain application methods, not the raw private Data API. Keep that API private. Configuration/grants are static for this initial process; changing grants requires restarting the application. Live revocation, signup and worker provisioning belong to the operational multi-user phase.

Read operations: notebook/note listing, note lookup, keyword search, note changes. Small write operations: create Markdown note, update title/body. HTML imports, arbitrary paths/routes, deletion, resource upload and administration are deliberately not exposed by this increment. This is not a permanent exclusion of those features. Reads/search suppress encrypted, trashed and locked notes; pages may contain fewer visible items while `hasMore` still reflects upstream pagination. Lists are not transactional snapshots.

The HTTP adapter talks to the actual Data API request shapes inspected in the pinned source. It uses `PUT` for partial updates, query-token authorization and cursor-based `/events`. URL and token come only from trusted configuration. Redirects are rejected, request timeouts are enforced, and extra response fields are filtered. Only explicitly marked HTTP 400 model validation messages are passed to callers; other upstream error bodies and stacks are not copied into application errors. It logs no note payload or token. HTTP is allowed for loopback; explicitly permit other private HTTP only when the deployment accepts that transport. HTTPS is supported.

A POST/PUT transport failure, server error or unusable success response can mean the change committed. The error reports `write_outcome_unknown`; there is **no automatic mutation retry** and no idempotency/atomic stale-write guarantee. The pre-update eligibility read is best effort, not compare-and-swap. Initial Markdown updates apply only to Markdown notes; unsupported formats stay read-only through this adapter.

## Search and embedding contracts

`search({ query, mode, page, limit })` supports the three agreed request modes. Keyword runs Joplin search with its syntax/ranking. Explicit semantic search returns `executedMode: null`, `semantic.state: 'unavailable'`, `reason: 'not_implemented'`; an empty result does not pretend the index was searched. Hybrid currently executes keyword only and labels that fallback and each hit's provenance. The contract does not yet implement fusion, embeddings indexing or a relevance ranking beyond upstream search.

`embed(texts, purpose)` is an **internal** indexing/query operation, not a public unlimited inference endpoint. An injected, trusted embedding transport receives prepared text and purpose. The default has no transport and reports `embedding_provider_unavailable`. Fake-provider tests exercise account selection, exactly-once document/query prefixing, OpenAI-style indexed response order, count, dimensions, finite/nonzero values, optional L2 normalization, cancellation and error redaction. Phase 2B supplies the real HTTP provider implementation. No note was sent to a remote embedding service here.

Embedding identity includes operator-assigned space ID, effective revision description, dimensions, normalization, query/document preparation and preprocessing version. Endpoint, API credentials and batching are not part of that fingerprint. An alias is not proof of vector equivalence. A changed fingerprint requires an explicit compatibility/rebuild decision; a query-only preparation change need not re-embed unchanged document representations. `noteFingerprint` hashes exact title/body and preprocessing version. Chunker identity is separate in the store.

BGE-M3 dense plus Joplin lexical search remains a candidate, not an implementation dependency or a selected winner. The fake tests deliberately use two dimensions so they cannot be confused with BGE-M3 or Qwen output.

## Semantic storage contract

`schema/semantic-v1.sql` defines a **future separately keyed per-account SQLCipher store**, not additional tables in the Joplin database. Phase 1.5 does not open or create that store. `databasePath` and `keyRef` bind its future owner; the key reference is not a key and does not unlock the CLI profile.

Tables: `index_config` (one active generation), `note_state` (pending/indexed/error/deleted and source fingerprint), `chunks` (ordered offsets, optional valuable excerpt, little-endian float32 vector), and `sync_state` (event cursor and reconciliation checkpoint). Foreign keys enforce generation/dimension alignment; vector byte length must match dimensions. Apply the DDL only after SQLCipher key verification. Running it in ordinary SQLite does not encrypt anything.

Phase 2B must persist invalidation/pending work and the cursor together; replace a note's chunks and successful-state marker transactionally; reject stale in-flight source content; purge deleted/ineligible notes; reconcile missed/coalesced changes. Result delivery checks current source eligibility through the account's API. There is no transaction across Joplin and the semantic DB. A rebuild can pause semantic search while keyword search stays usable. Credentials and key material do not belong in the semantic schema.

The Python tests use ordinary in-memory SQLite **only to test relational constraints and rollback**, not encryption or a real indexer. `source_updated_time` alone is not a content fingerprint. Key handling and useful retrieval remain Phase 2B acceptance work.

## Example (application startup, not a public endpoint)

```js
import { createAccountRegistry } from './index.mjs';
const registry = createAccountRegistry([{
    id: 'ming',
    subjects: ['verified-auth-subject'],
    permissions: ['read'],
    joplin: { baseUrl: 'http://127.0.0.1:41184/', token: apiTokenFromProtectedSource },
    semantic: { databasePath: '/data/semantic/ming.db', keyRef: 'ming/semantic-key' },
}]);
const account = registry.forPrincipal(authenticatedSubject, 'ming');
const result = await account.search({ query: 'postgres replication', mode: 'hybrid' });
// result.executedMode === 'keyword'; semantic remains explicitly unavailable.
```

Do not serialize configuration into client-visible responses. Do not expose the internal `embed` method directly through MCP without the integration's access/usage policy. A loopback provider may be a relay: `remoteProcessing` is the operator's disclosure decision, not a cryptographic or OS-level egress control.

## Tests without the Joplin dependency tree

From repository root:

```sh
node --test extras/headless-service/tests/*.test.mjs
python3 extras/headless-service/tests/schema_test.py
# Optional static consumer-contract check (uses whichever tsc you explicitly select):
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext \
  extras/headless-service/tests/types.test.mts
```

The HTTP tests use real loopback networking with a simulated Data API, not a compiled Joplin process. They do not replace the following read-only actual-account check.

## Complete the one-real-account check on the existing builder

Keep the already passing Phase 1 source/build and recovery material. Do not reset E2EE or rerun its long acceptance sequence just to test this library. Start the configured encrypted `serve` process normally (one profile owner), using the existing key. Obtain its already provisioned API token without writing it to logs. Make a private token file and a private JSON file based on `scripts/account-smoke.example.json` (mode 0600). Use an existing synthetic test note ID and an exact search term that finds it. The adapter requests at most 100 matches. Do not use a production note merely to prove this test.

```sh
node extras/headless-service/scripts/check-account.mjs /private/account-smoke.json
```

This makes **GET requests only** to the running Data API: notebook listing, read, keyword search and cursor lookup. It also verifies explicit semantic unavailability and a synthetic in-memory fake-provider call. It does not create notes, touch the database, reconfigure sync/E2EE, create an index or contact an embedding host. Only sanitized step names and a small result are printed; retain the normal exit code this time if convenient.

A successful `PASS phase15-account-smoke` against the real compiled core completes the outstanding Phase 1.5 integration observation. Share only that output and the source ID, not the private JSON/token/profile. The same script is self-tested here against a fake Data API; that is harness evidence only.

## Phase 2A: MCP entry point

`mcp.mjs` exposes this account-bound service over stdio, read-only by default, with optional Markdown create/update tools. See [MCP.md](MCP.md) for the configuration, tool contract, transport scope, native integration test and remaining selected-host check. This adds no package dependencies, public HTTP listener or semantic indexer, and does not change the Joplin CLI core.


## Phase 2B semantic retrieval

Optional semantic indexing and hybrid retrieval are implemented outside the core. See [SEMANTIC.md](SEMANTIC.md) for configuration, separate encrypted storage, runtime ownership, limits and real-provider acceptance. Existing account/keyword behavior remains available without enabling it. The new native integration uses a real encrypted core and store with a fixture HTTP embedding endpoint; it does not establish model quality.

## Stateless HTTP MCP entry point

`mcp-http.mjs` exposes the same account-bound tools through authenticated `POST /mcp`, with separate health and readiness endpoints. It defaults to loopback, requires a private bearer token file, and shares the optional semantic runtime. See [MCP.md](MCP.md#phase-2c-stateless-http-transport) and `scripts/mcp-http.example.json` for configuration and protocol details. The listener does not implement OAuth or deploy a proxy.

## Phase 5 — managed accounts

[Multi-user operation](MULTI-USER.md) adds a small Linux supervisor, separate
account workers, a restricted core-setup wrapper, durable disable/re-enable and
an authenticated local MCP bridge sharing the existing semantic owner. Legacy
single-account entries remain usable. Start with `scripts/fleet.example.json`
and `scripts/fleet-account.example.json`; use [the focused acceptance guide](CODEX-PHASE5-VALIDATION.md).
The four user-deferred Phase 4 observations are tracked in [BACKLOG.md](BACKLOG.md),
not treated as Phase 5 prerequisites or passed tests.
