# Phase 2A: account-bound MCP over stdio

The MCP adapter exposes account-bound tools and short-lived file resources. It imports the account interface rather than Joplin internals. No package installation is needed.

This section describes the original stdio transport. Stdio remains available; the stateless HTTP transport is documented below.

## Run

Start the encrypted headless core using its existing profile, DB key and API token. Run this adapter in a network namespace where that private API is reachable. It does not start or stop the core and does not need the database key or E2EE password.

Copy `scripts/mcp.example.json` to an absolute local configuration path and change its account ID, API base URL and token-file path. The example is:

```json
{
  "accountId": "personal",
  "baseUrl": "http://127.0.0.1:41190",
  "apiTokenFile": "/run/secrets/joplin-personal-api-token",
  "allowWrites": false
}
```

`apiTokenFile` must be an absolute path to a regular file readable by the process with no group/other permissions, for example mode `0600`. It contains the existing API token with an optional trailing newline. Supply it from an appropriate runtime secret source; a permission-protected plaintext file is not itself encryption. Keep it outside published artifacts/backups. The JSON contains no raw token and need not be encrypted. Optional settings: `timeoutMs` (default 10,000, up to 120,000), `allowInsecureHttp` for a deliberately trusted private HTTP route, `defaultNotebookId` (retained by the shared account configuration; the MCP `create_note` tool still requires an explicit notebook destination), and the reserved `semanticDatabasePath`/`semanticKeyRef`. Phase 2A never opens that semantic path or obtains its key.

```sh
node /absolute/repo/extras/headless-service/mcp.mjs /absolute/private/mcp.json
```

The process waits for MCP input. There is no ordinary startup banner on stdout: stdout is the JSON-RPC channel. Diagnostics on stderr are fixed codes, not notes, credentials, URLs or backend errors. It needs Node 22.12 or newer, but no SQLCipher addon in the adapter process. The separately running core still needs its native environment.

In a host that accepts stdio command/arguments, configure that command directly. For Codex CLI, the documented form is:

```sh
codex mcp add joplin-headless -- \
  node /absolute/repo/extras/headless-service/mcp.mjs /absolute/private/mcp.json
```

Then inspect `/mcp` in Codex and ask it to list notebooks, search for a known synthetic note and read it. This command is documentation, not a claim that Codex was installed or exercised in the sandbox. If the API is accessible only inside a container, run the adapter there (for example with `docker exec -i`, **without** a pseudo-TTY), or use an already protected route. Do not publish the raw Data API to solve networking. No Docker command was run here.

## Tools

| Tool | Behavior |
| --- | --- |
| `get_status` | Internal account ID, Joplin account email and semantic index state, plus the core process's current sync activity, latest sync report, and decryption worker state. `accountEmail` comes from the authenticated Joplin Server or Joplin Cloud user profile, including when signing in with an app ID and app password. It is null for unsupported sync targets or an unavailable profile email. Profile lookup failures return a status error. `accountId` is the local account binding, such as `personal`. Sync details include pending work, report timestamps, available operation/fetch counters, and an error count. Decryption details include the last-reported worker batch while active, whether a master key is missing, and the count of disabled records. A new decryption run may still show the previous batch until fresh progress arrives. |
| `list_notebooks` | Returns the complete readable notebook list with note counts in `notebooks`. Takes no arguments. |
| `list_notes` | Paged readable notes with short previews. |
| `search_notes` | Joplin query syntax, including `notebook:`, `tag:`, `title:`, `body:`, `any:`, `type:`, `iscompleted:`, `created:`, `updated:`, `due:`, `sourceurl:`, and `resource:` filters. Combine filters with spaces and prefix a filter with `-` to negate it. Returns a snippet window up to 240 characters around the first non-filter keyword; ellipses mark omitted text. The optional `mode` supports the existing `keyword`, `semantic`, and `hybrid` behavior. |
| `semantic_search_notes` | Read-only tool with the Desktop input schema: required `query`; optional `notebook_id` or `tag_id`; optional `relevance` (`strict`, `normal`, or `loose`, default `normal`). The schema is listed even without semantic runtime setup, but calls return an explicit unavailable/not-implemented result. |
| `read_note` (`get_note` alias) | `output` selects `inline` (the default), `file`, or `metadata`. Inline output returns the body and note metadata including `notebook_id`, `notebook_title`, `tags`, `is_todo`, `todo_completed`, `created_time`, `updated_time`, `body_length`, `body_offset`, `body_returned_chars`, `has_more`, and native `revision_id`. Reading captures the current native history snapshot when it has not already been recorded. `offset` uses UTF-16 code units. Omitted or `0` `max_chars` returns the full remaining body; a positive value requests a chunk. Legacy positive `length` remains accepted when `max_chars` is omitted. Surrogate pairs are kept intact. Metadata output returns no body, file descriptor, or embedded file resource; it returns the current native revision and note metadata, plus `body_length` in UTF-16 code units, `body_size_bytes` as the exact UTF-8 byte count, and `body_sha256` as the SHA-256 of the exact UTF-8 body. File output returns the complete body as UTF-8 Markdown or HTML: the result keeps the matching native `revision_id` and note metadata, adds a file descriptor, and returns the bytes only as an embedded MCP resource. `metadata` and `file` output cannot be combined with `offset`, `max_chars` or `length`. |
| `create_note` | Only with `allowWrites: true`: creates a Markdown note, optionally with a body or `body_file`, and to-do state. Pass `notebook_id` or its legacy alias `parentId`; an existing notebook destination is required, so use `list_notebooks` to find one. `body_file` has the same `{download_url, file_id, mime_type?, file_name?}` object and OpenAI `openai/fileParams` metadata as `update_note`; it is exclusive with `body`. The server completes the strict UTF-8 HTTPS download before creating the note. No separate adapter body-file size limit applies; core Joplin validation still applies. The existing two-step body-write behavior and unknown-outcome handling still apply. Returns the same compact `id`, `title`, and `notebook_id` result. |
| `update_note` | Only with `allowWrites: true`: requires `id` and the native `base_revision_id` returned by `read_note`, then partially edits an eligible note, including title/body replacement, append, prepend, one unique text replacement, notebook move, or to-do completion change. Prefer partial body operations for small edits, `body_file` for large rewrites, and `body` replacement when appropriate. Body edits preserve the existing Markdown or HTML format. For a file roundtrip, pass `body_file` with required `download_url` and `file_id`, and optional `mime_type` and `file_name`; it replaces the complete body and cannot be combined with `body`, `append`, `prepend` or `replace_text`. Title, notebook and to-do metadata changes can accompany it. The tool advertises `body_file` through OpenAI's `openai/fileParams` metadata. The server fetches strict UTF-8 text over HTTPS from public destinations; the MCP adapter imposes no separate body-file size limit, and core Joplin validation still applies. The existing revision-guarded save and compact result (`id`, `updated_time`, `revision_id`, `previous_revision_id`, `changed`) still apply. A `body_file` update also returns `body_length` in UTF-16 code units, `body_size_bytes` as the exact UTF-8 byte count, and `body_sha256` as the SHA-256 of the native saved body snapshot associated with the returned `revision_id`; these values describe the saved snapshot, not the downloaded input. |
| `delete_note` | Only with `allowWrites: true`: moves an eligible note to Trash. |
| `create_notebook` | Only with `allowWrites: true`: creates a notebook, optionally under a readable parent notebook. Preserves the supplied title, including surrounding spaces, while rejecting blank titles. |
| `list_tags` | Lists readable tag IDs and titles, including tags with no attached notes so standalone tags remain discoverable. |
| `manage_tags` | Only with `allowWrites: true`: adds or removes tag titles on an eligible note using Joplin's native title lookup; adding a missing title creates that tag. |
| `list_note_revisions` | Pages through retained native revisions for `note_id`, newest first, returning revision IDs, parent IDs and capture times. |
| `read_note_revision` | `output` selects `inline` (the default), `file`, or `metadata`. Inline output reconstructs the selected native revision's title, body and tracked metadata, with optional UTF-16-safe chunks. File output returns a descriptor and an embedded UTF-8 resource for the complete historical body; the result identifies the native revision, its capture time, title and metadata. Metadata output returns those same revision details without the body, descriptor or resource, plus `body_length` in UTF-16 code units, `body_size_bytes` as the exact UTF-8 byte count, and `body_sha256` as the SHA-256 of the exact UTF-8 body. `file` and `metadata` reject `offset` and `max_chars`. Retained history can be read after the live note is deleted. A historical revision is not automatically a valid edit base; call `read_note` for the current note before `update_note`. |
| `compare_note_revisions` | `output` selects `inline` (the default) or `file`. Inline output returns title/body diffs and structured metadata changes between native revision IDs. File output returns a `.diff` file descriptor and embedded resource containing the exact title and body patch strings in labeled sections; `metadata_changes` and both revision IDs remain inline, while the patch strings are omitted from ordinary JSON. Omit `to_revision_id` to capture and compare with the current live note; the response includes that snapshot's native revision ID. Explicit endpoints also work for retained history after deletion. |
| `list_conflicts` | Pages through active, readable conflict copies in this headless profile, with their original-note links and timestamps. Conflict copies are local to the client that detected them and are not synchronized from other devices. |
| `read_conflict` | `output` selects `inline` (the default), `file`, or `metadata` for both sides. Each available side keeps its `id` and status. Inline output includes its content; file output adds a `note.file` descriptor and embedded resource for each available body; metadata output includes `body_length` in UTF-16 code units, `body_size_bytes` as the exact UTF-8 byte count, and `body_sha256` as the SHA-256 of the exact UTF-8 body on each side's `note`, without exporting its body. Unavailable sides keep their existing status and have no fabricated revision or file. Reading does not capture native revisions. Optional `offset` and `max_chars` apply to each readable side with independent body continuation metadata; non-inline output rejects them. The original remains a read of its current content, not a frozen conflict-time snapshot. Before editing either side, call `read_note` to obtain the target's current native revision for `base_revision_id`. |
| `update_notebook` | Only with writes enabled: renames a notebook or moves it under `parent_id`; an empty parent ID moves it to the root. Uses Joplin's native nesting rules. |
| `delete_notebook` | Only with writes enabled: moves a notebook subtree and its notes to Trash. |
| `create_tag` | Only with writes enabled: creates a standalone tag. |
| `rename_tag` | Only with writes enabled: renames a readable tag by ID. |
| `list_note_attachments` | Lists attachment metadata linked from a readable note. |
| `read_attachment` | Returns readable resource metadata and file bytes in an embedded MCP resource content block. The file must be available locally and decrypted. |
| `create_attachment` | Only with writes enabled: uploads either `content_base64` or `content_file` as a standalone resource and returns its existing compact metadata result. `content_file` uses the same `{download_url, file_id, mime_type?, file_name?}` object and OpenAI `openai/fileParams` metadata as `update_note`. The server preserves downloaded bytes exactly without UTF-8 decoding. The inputs are exclusive; creation requires an explicit filename and one byte source. Existing explicit filename, title and MIME type arguments remain supported. Insert the returned Markdown link with a separate revision-checked `update_note`. |
| `update_attachment` | Only with writes enabled: keeps the existing filename, title and MIME type arguments and can rename metadata, replace bytes with `content_base64` or `content_file`, or update metadata alone. `content_file` uses the same file object and OpenAI `openai/fileParams` metadata as `update_note`; it preserves downloaded bytes exactly without UTF-8 decoding and is exclusive with `content_base64`. The existing compact metadata result is unchanged. Note revisions do not retain previous attachment bytes. |

`observedAt` and `serviceStartedAt` are Unix epoch milliseconds. The report is kept in memory and resets when the process restarts; `sync.running` reports live activity, while `report.state` can lag. Decryption batch indices are zero-based. While the worker is started, `batch` is the last-reported batch and may still describe the previous run until fresh progress arrives.

Where a tool result identifies the account, `accountEmail` is the authenticated Joplin profile email, or null when unavailable. Ordinary tool results omit the local binding ID; `get_status` retains `accountId` for diagnostics. The MCP adapter reuses successful email lookups across requests for the bound service. An unavailable auxiliary email lookup does not fail a successful note or maintenance operation. These response fields do not select an account: every tool is already bound to the configured account.

`search_notes` returns each match once in `results`, with its ID, title, notebook ID, update time and snippet. Pagination uses `hasMore`; there is no second `items` array. Explicit semantic/hybrid searches also retain available score, provenance, semantic excerpt and chunk metadata on each result, along with execution status at the top level. The built-in keyword search returns `total` as the exact count of matching readable notes across all search pages, not the number on the returned page. The count scans note metadata and excludes encrypted, deleted, or locked notes. The existing semantic and hybrid modes remain separate and may work when the headless semantic engine is configured; configuring that engine does not enable the dedicated `semantic_search_notes` handler.

Create and update acknowledgements omit the note body and the former `saved`/`synchronization` fields. A `body_file` update keeps the same compact acknowledgement fields and adds the saved snapshot's `body_length`, `body_size_bytes`, and `body_sha256`. Use `read_note` with `output: metadata` to discover the current body's size or identify its exact content by hash without returning the body. After a file update, compare the local input file's exact UTF-8 byte count and SHA-256 with the acknowledgement to check the saved content. For optional export verification, use `read_note` with `output: file` and compare its descriptor's existing `size` and `sha256`; neither step requires returning the full body inline. For large bodies, use `output: file` to handle the exported body as a file/resource instead of inline text; use `body_file` to submit a complete rewrite from a local file. There is no numeric size threshold. Use `get_status` to inspect sync activity.

The catalog exposes 26 tools when `allowWrites` is true: 15 read tools and 11 write tools. With writes disabled, the 11 write tools are omitted from `tools/list`. Current-note reads and comparisons may capture native revision history without changing note content. The Desktop `read_image` resource tool is not included. The `semantic_search_notes` entry publishes the Desktop schema, but its implementation currently returns an explicit unavailable/not-implemented result regardless of semantic runtime configuration. List/search default to 20 notes and accept up to 100 per page. `list_notes` previews contain up to 320 UTF-16 code units. Tool strings and tag arrays have no additional size caps; writes remain subject to Joplin's model validation. Metadata-only updates leave the body untouched; body edits use the existing note's format without conversion. There is no standalone export tool, shell, filesystem, arbitrary-URL, plugin or administrative tool.

File output from `read_note` is an immutable UTF-8 snapshot of the same native revision returned in its metadata. Its descriptor includes a filename, MIME type, byte size as `size`, SHA-256 as `sha256`, and expiry time. Historical revision bodies, revision comparison patches and available conflict-side bodies use the same account-bound export store, authorization and lifetime. Embedded resources carry the bytes; ordinary text and `structuredContent` do not repeat file contents or Base64. Resource URIs can be read with authenticated `resources/read` and listed with `resources/list`. Exports remain in account/server memory for 15 minutes, then expire; a process restart or server shutdown also removes them, so export the content again to get a new URI. Metadata outputs include exact body measurements without creating an export.

File input depends on host support for the OpenAI `openai/fileParams` metadata. The earlier live ChatGPT connector run verified an agent-generated local file becoming a `download_url` and `file_id` object for `update_note.body_file`; a local filesystem path is not sent to or opened by the MCP server. The server fetches the supplied file object over HTTPS. The six additions described here—historical revision file/metadata output, comparison file output, conflict file/metadata output, `create_note.body_file`, `create_attachment.content_file`, and `update_attachment.content_file`—have not been live-verified in ChatGPT or Codex and have not been deployed. MCP support by itself does not establish that a client can adapt local paths for these file inputs.

A live ChatGPT connector run verified an earlier connector-only Markdown roundtrip at about 2 MiB: import a generated local file with `update_note.body_file`, materialize it with `read_note` and `output: file`, make a local marker edit, reimport with a revision check, then export the final note. Byte sizes and SHA-256 checks confirmed that imports and exports preserved the expected file contents, and every checked file had zero U+FFFD replacement characters. Update acknowledgements remained compact and omitted the body. This run predates `read_note`'s `metadata` output, its body measurement fields, the measurement fields in file-mode update acknowledgements, and all six additions listed above; it does not verify those newer contracts. Refresh the connection's tool catalog after changing input schemas; a stale cached catalog initially rejected the then-current `body_file` inputs. This verifies only the earlier tested ChatGPT `update_note.body_file`/`read_note` roundtrip, not every MCP host or the additions documented here. The [detailed workflow record](../../chatgpt-work/DESKTOP-MCP-PARITY-HANDOFF.md) contains the trace and environment-specific evidence.

Attachment creation and updates use fixed native headless actions. Joplin derives the resource path from the final filename extension and MIME type; filename or MIME changes keep the existing bytes accessible, including extensionless files. Replacing bytes follows Joplin's resource update lifecycle. These operations do not retain earlier attachment bytes.

When `create_note` receives a non-empty `body` or a downloaded `body_file`, it first creates an empty note and then writes the body separately, avoiding Joplin's server-side media extraction on note creation. A `body_file` is fully downloaded and validated as UTF-8 before creation begins. If the body write fails after creation, the result is `write_outcome_unknown`; the adapter does not retry automatically.

When Joplin rejects a save through its model validation, MCP returns `validation_error` with the validation message and `outcomeUnknown: false`. This applies to a rejected update or the initial create request. A validation failure during the second request of note creation retains the partial-create handling described above.

The server returns JSON both in MCP text content and `structuredContent`. Every registered tool publishes an `outputSchema` describing its success and structured-error result shapes. The `read_attachment` and file-mode `read_note` outputs describe their metadata in JSON; file bytes are returned in an embedded resource block without duplicating Base64 in that metadata. Tool input rejects extra fields, including `accountId`, `baseUrl`, `token` and arbitrary Joplin properties. No tool changes which account is bound. Annotations describe reads/writes but are hints, not the permission boundary.

## Authorization and writes

Stdio is a locally spawned process. Access to its configured token is the authority; `clientInfo`, a tool argument or a fabricated user ID never authenticates a caller. The launcher creates a single account context via the existing registry. Library callers can use separate account-bound sessions; provisioning multiple users remains a later phase.

Read-only is the default. Enabling writes is a local operator decision, and the account service must separately permit writes. Require the MCP host to obtain user approval before mutations. The adapter does not implement an approval UI and must not claim that a JSON `confirm: true` proves human consent. Treat retrieved note text as untrusted data, not instructions to run tools.

MCP note updates atomically check the loaded note state and save the note with its before/after native revisions. A stale base returns `note_conflict` without applying the edit; read and compare the new state before merging. These checks cover changes known to the headless profile; remote changes become visible after sync. No automatic write retry or exactly-once guarantee is provided. A lost/invalid response after a write returns `outcomeUnknown: true`; inspect the note/list before deciding to retry. MCP request IDs are not durable idempotency keys. Tests force a dropped response after a simulated server commit and verify no retry.

## Native note history

`read_note` returns a native Joplin `revision_id` for its exact snapshot. Supply it as `base_revision_id` on `update_note`. A changed edit returns `revision_id` for the saved state, `previous_revision_id` for the immediate before state, and `changed: true`. An unchanged edit returns `changed: false` and reuses the snapshot. There is no separate version-token system.

MCP capture runs even when scheduled history collection is disabled. Newly captured revisions use capture time for native ordering and retention while retaining the note's own timestamps and tracked metadata. Joplin's existing retention policy still applies. Revision history includes title, body and native tracked note metadata; tag relationships and previous attachment bytes are not part of it. Missing, encrypted or broken revision ancestry produces an explicit error.

Agents can inspect changes with `compare_note_revisions`, read historical content when needed, and selectively merge through `update_note`. The tools do not rewrite revision records or provide a separate restore operation. Tag and revision deletion and permanent attachment deletion are not exposed.

## Conflict inspection

Use `list_conflicts` to find conflict copies in the headless profile, then `read_conflict` to read a copy and its linked original. Each side has an `id` and a `status`: `available`, `missing`, `trashed`, `encrypted`, `locked`, or `unlinked`. Only an available side contains note content. An unlinked original has no ID. The original is read as it exists now, rather than as a frozen snapshot from the moment of conflict.

The agent compares the content and chooses what to merge. Before updating a target, use `read_note` to obtain its current native `revision_id`, then pass that ID as `base_revision_id` to `update_note`. A reviewed conflict copy can be moved to Trash with `delete_note`. Inspection does not perform comparisons, modify either note or mark a conflict resolved.

## Protocol scope and maintenance

The MCP adapter supports modern **2026-07-28** requests and legacy **2025-11-25** and **2025-06-18** requests. Modern requests have no `initialize` handshake: each request carries `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` in `params._meta`; an empty capabilities object is valid, and `clientInfo` is optional. Modern `server/discover` is required and reports the supported versions. Legacy stdio clients keep the existing `initialize` and `notifications/initialized` lifecycle. Successful modern results include `resultType: "complete"` and server identity in result `_meta`; `server/discover` and `tools/list` also return `ttlMs: 0` and `cacheScope: "private"`. HTTP responses retain `Cache-Control: no-store`; that header is separate from the MCP result cache hints. Modern stdio cancellation uses `notifications/cancelled` without `_meta`, aborts the matching operation and suppresses its response; legacy cancellation remains unchanged.

The implemented method surface is `server/discover`, `tools/list`, `tools/call`, `resources/list` and `resources/read` for modern requests. Optional features such as MCP Apps, Tasks, resource templates and subscriptions, prompts, sampling and OAuth are not implemented. Attachment bytes and file-mode note bodies are embedded directly in their tool results, and note file URIs can be read again through `resources/read`. See the official [2026 versioning](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/versioning.mdx), [stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching) and [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) pages for the protocol contract.

The existing Joplin MCP class was inspected. It is tied to the internal singleton tool registry and Joplin's semantic store; importing it would bypass the external account service. The supplied locked/offline runtime also does not contain the official MCP SDK. This increment implements a small tools-only wire layer with Node built-ins without adding an MCP SDK dependency. Native revision operations now use a fixed authenticated core action catalog so capture and conditional saves share the core transaction. Tool inputs use explicit per-tool schemas, including the nested structures currently needed by the catalog; this is not a general JSON Schema engine. Before adding optional extensions or substantially broader transport behavior, reconsider adopting a pinned official SDK outside the CLI fork rather than expanding this layer into a general framework.

For stdio, active tool calls are limited to eight. Excess concurrent calls fail explicitly. Frames and results have no application byte ceiling, and queued responses honor output backpressure. Cancellation reaches the private API's AbortSignal. EOF/SIGTERM/SIGINT stop dispatch, abort pending calls and drain responses, with a five-second bound. Incomplete/invalid UTF-8 JSON frames fail without echoing input.

The Phase 2A stdio launcher did not open a network MCP listener. The stateless HTTP listener documented below is a separate launcher and configuration. It is not an OAuth gateway or a Cloudflare Worker deployment.

## Tests and observations

```sh
# Built-in tests; native integration explicitly skips without both runtime variables.
node --test extras/headless-service/tests/*.test.mjs
python3 extras/headless-service/tests/schema_test.py

# Run the real native integration when the offline runtime is available.
# First apply README-run.txt's PATH, LD_LIBRARY_PATH and native override exports.
export JOPLIN_MCP_TEST_CLI="$PACK/workspace/packages/app-cli/build/main.js"
node --test extras/headless-service/tests/mcp-native.test.mjs

# Short read-only wire smoke against an already running core.
# Optional final arguments select a known synthetic note and a query that matches it.
node extras/headless-service/scripts/check-mcp.mjs /private/mcp.json [NOTE_ID] [QUERY]
```

The native test creates fresh disposable local profiles, synthetic keys/tokens and an E2EE filesystem sync target. It never touches an existing profile/account or sends notes to an external provider. It checks MCP create/update/read/FTS, raw API authorization, automatic E2EE upload, normal-mode client download/decryption/read, read-only rejection, account-argument rejection and restart persistence. All test profiles and processes are removed afterward.

That normal-mode client uses the **same compiled binary with headless mode disabled**, not an independently built unmodified upstream binary. The sync target is a local filesystem, not a new Joplin Server validation. Existing builder evidence for the earlier stock-client/Server round trip is carried forward, not relabeled as a new local run.

The test/reference client in `scripts/lib/stdio-client.mjs` is deliberately separate from the server implementation and runs it as a subprocess. It is **not the official SDK**. Passing these tests does not prove that Codex, Claude Desktop, Cursor or every SDK interoperates. The remaining selected-host observation is the short Codex read/search test described above. Do not repeat Phase 1's long autonomous test solely for this host check.

## Primary references checked for this increment

- MCP stdio framing: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Lifecycle and version negotiation: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- Tools, result content and errors: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Cancellation: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
- Codex stdio setup: https://developers.openai.com/codex/mcp/

The sources define protocol and host behavior; the repository tests/logs establish only the observations stated above.


## Phase 2B extension

The Phase 2A read-only Codex CLI observation has passed; its exact report is in `evidence/2026-09-20-codex/`. The original instructions above describe the Phase 2A baseline.

A configured `semantic` block now enables meaning-based and hybrid retrieval in `search_notes` and starts a per-account indexer in this process. See [SEMANTIC.md](SEMANTIC.md). This process then owns a separate SQLCipher index and its key; it still never opens the core Joplin DB or needs the core DB/E2EE keys. Unconfigured clients retain explicit semantic-unavailable behavior. The Phase 2B semantic extension did not add a public transport or authentication scheme; the HTTP transport is documented below.

## Phase 2C: stateless HTTP transport

The HTTP launcher uses the same account-bound service and MCP tools as stdio, including the optional semantic runtime when configured. Each HTTP POST is handled as an independent, stateless MCP exchange; there is no server-side MCP session to resume. Stdio remains available for hosts that launch local processes.

Copy `scripts/mcp-http.example.json` to an absolute private configuration path and set `accountId`, `baseUrl` and `apiTokenFile` for the existing headless core. Keep `allowWrites` false unless the operator intentionally enables mutations. The API token file and `bearerTokenFile` must both be absolute paths to private regular files with no group/other permissions, for example mode `0600`. The bearer file contains a separate MCP bearer credential, not the Joplin API token. Both files may have a trailing newline. Supply them from an appropriate runtime secret source; private plaintext files are not encryption.

`listenHost` defaults to `127.0.0.1` and `listenPort` to `41191`. `allowedOrigins` defaults to `[]`; when a request supplies an `Origin` header, it must exactly match one of the configured HTTP(S) origins. Requests without an `Origin` header are allowed by this check. Origin matching is not authentication. The optional semantic settings are described in [SEMANTIC.md](SEMANTIC.md).

Run the HTTP launcher with the absolute config path:

```sh
node /absolute/repo/extras/headless-service/mcp-http.mjs /absolute/private/mcp-http.json
```

### HTTP behavior

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Unauthenticated liveness check; returns `200` while the listener is running. |
| `GET /readyz` | Unauthenticated account probe that lists at most one note summary; returns `503` if the configured account service cannot respond. |
| `POST /mcp` | Requires `Authorization: Bearer …` and `Content-Type: application/json`. MCP clients must send `Accept: application/json, text/event-stream`. The response is always a single JSON response, never an SSE stream. |

For a modern HTTP request, `params._meta` must contain the full namespaced `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` keys; `{}` is valid for capabilities, and `io.modelcontextprotocol/clientInfo` is optional. `MCP-Protocol-Version` must equal the version in the body. `Mcp-Method` must equal the JSON-RPC `method`; `Mcp-Name` must equal `params.name` on `tools/call` or `params.uri` on `resources/read`, and is omitted for `server/discover`, `tools/list` and `resources/list`. Standard `=?base64?...?=` name values are decoded before comparison. Routing headers are validated for unsupported `prompts/get` (`params.name`) requests before returning method-not-found. Missing or invalid required body metadata returns HTTP `400` with JSON-RPC `-32602`; mismatched headers return `400` with `-32020`; an unsupported version returns `400` with `-32022` and `error.data.supported`/`requested`; an unknown modern method returns `404` with `-32601`.

Use this modern request shape for `server/discover`. Provide the authorization value from the private bearer-token file through the MCP client or secret provider; do not place the token in a command or log:

```http
POST /mcp
Authorization: Bearer <contents of bearerTokenFile>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: server/discover

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { "name": "example-client", "version": "1" }
    }
  }
}
```

The HTTP endpoint retains the legacy 2025 request path: legacy `initialize` may omit `MCP-Protocol-Version`, while other legacy messages require a supported version header. Valid legacy notifications and JSON-RPC response messages receive HTTP `202` with no body. Modern notifications and client response messages are rejected with HTTP `400`; modern requests do not use `initialize`, `ping`, `notifications/initialized`, or a session ID. With valid bearer authentication, `GET` and `DELETE /mcp` return `405`. The endpoint provides no SSE stream or session resumption, including for legacy requests.

The HTTP transport has no application byte ceiling for request bodies or responses and allows eight active MCP dispatches. A client disconnect does not cancel an already dispatched tool call, and the server does not retry it. An HTTP response lost after a write may leave the outcome unknown; inspect the note before deciding whether to retry. Modern HTTP notifications are rejected, and cancellation cannot cross requests because each POST is independent. Server shutdown aborts active tool calls and bounds draining to five seconds.

The listener speaks plain HTTP and defaults to loopback. Keep the default listener private. For remote access, use an operator-managed protected TLS route; the transport does not implement OAuth or trust proxy identity headers. The bearer credential grants access to one configured operator account and does not identify an end user. Do not expose the Joplin Data API to clients.

Run the focused protocol/HTTP checks with `node --test extras/headless-service/tests/mcp.test.mjs extras/headless-service/tests/mcp-http*.test.mjs extras/headless-service/tests/mcp-modern*.test.mjs`. The HTTP checks use synthetic APIs and loopback networking. No deployment or selected-client interoperability observation for the 2026 protocol is recorded here.
