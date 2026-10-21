# Phase 2A: account-bound MCP over stdio

This increment adds a runnable tools-only MCP adapter to the external application. It imports the accepted account interface, not Joplin internals, and does not change `packages/`, root manifests, database formats or `yarn.lock`. No package installation is needed.

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

`apiTokenFile` must be an absolute path to a regular file readable by the process with no group/other permissions, for example mode `0600`. It contains the existing API token with an optional trailing newline. Supply it from an appropriate runtime secret source; a permission-protected plaintext file is not itself encryption. Keep it outside published artifacts/backups. The JSON contains no raw token and need not be encrypted. Optional settings: `timeoutMs` (default 10,000, up to 120,000), `allowInsecureHttp` for a deliberately trusted private HTTP route, `defaultNotebookId` (a notebook ID used by `create_note` when none is supplied), and the reserved `semanticDatabasePath`/`semanticKeyRef`. Phase 2A never opens that semantic path or obtains its key.

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
| `get_status` | Account ID and semantic availability. Does not claim backend health or sync completion. |
| `list_notebooks` | The complete safe notebook list, with note counts. Legacy `page`/`limit` inputs and `items`/`hasMore` output fields remain available for existing callers. |
| `list_notes` | Paged readable notes with short previews. |
| `search_notes` | Joplin query syntax, including `notebook:`, `tag:`, `title:`, `body:`, `any:`, `type:`, `iscompleted:`, `created:`, `updated:`, `due:`, `sourceurl:`, and `resource:` filters. Combine filters with spaces and prefix a filter with `-` to negate it. Returns a snippet window up to 240 characters around the first non-filter keyword; ellipses mark omitted text. The optional `mode` supports the existing `keyword`, `semantic`, and `hybrid` behavior. |
| `read_note` (`get_note` alias) | Note body and metadata including `notebook_id`, `notebook_title`, `tags`, `is_todo`, `todo_completed`, `created_time`, `updated_time`, `body_length`, `body_offset`, `body_returned_chars`, and `has_more`. `offset` uses UTF-16 code units. Omitted or `0` `max_chars` defaults to 16,000 code units; legacy `length` remains accepted from 1 to 65,536. Surrogate pairs are kept intact. |
| `create_note` | Only with `allowWrites: true`: creates a Markdown note, optionally with a body and to-do state. The notebook can come from `notebook_id`, legacy `parentId`, `defaultNotebookId`, or the sole readable notebook when exactly one exists. |
| `update_note` | Only with `allowWrites: true`: partially edits an eligible Markdown note, including title/body replacement, append, prepend, one unique text replacement, notebook move, or to-do completion change. |
| `delete_note` | Only with `allowWrites: true`: moves an eligible note to Trash. |
| `create_notebook` | Only with `allowWrites: true`: creates a notebook, optionally under a readable parent notebook. |
| `list_tags` | Lists readable tag IDs and titles. |
| `manage_tags` | Only with `allowWrites: true`: adds or removes tag titles on an eligible note; adding a missing title creates that tag. |

The built-in keyword search returns `total` as the exact count of matching readable notes across all search pages, not the number on the returned page. The count scans note metadata and excludes encrypted, deleted, or locked notes. Existing semantic and hybrid behavior is unchanged.

The catalog has nine Desktop non-semantic tools plus the headless utilities `get_status` and `list_notes`. The five write tools are omitted from `tools/list` unless `allowWrites` is true. List/search default to 20 notes and accept up to 100 per page. `list_notes` previews contain up to 320 UTF-16 code units. Writes limit titles to 1,024 Unicode code points and bodies to 131,072, also subject to the transport frame cap. Other note formats can be read, but are not rewritten by the adapter. There are no export, shell, filesystem, arbitrary-URL, plugin or administrative tools.

When `create_note` receives a non-empty body, it first creates an empty note and then writes the body separately, avoiding Joplin's server-side media extraction on note creation. If the body write fails after creation, the result is `write_outcome_unknown`; the adapter does not retry automatically.

The server returns JSON both in MCP text content and `structuredContent`. Tool input rejects extra fields, including `accountId`, `baseUrl`, `token` and arbitrary Joplin properties. No tool changes which account is bound. Annotations describe reads/writes but are hints, not the permission boundary.

## Authorization and writes

Stdio is a locally spawned process. Access to its configured token is the authority; `clientInfo`, a tool argument or a fabricated user ID never authenticates a caller. The launcher creates a single account context via the existing registry. Library callers can use separate account-bound sessions; provisioning multiple users remains a later phase.

Read-only is the default. Enabling writes is a local operator decision, and the account service must separately permit writes. Require the MCP host to obtain user approval before mutations. The adapter does not implement an approval UI and must not claim that a JSON `confirm: true` proves human consent. Treat retrieved note text as untrusted data, not instructions to run tools.

Successful mutations mean **locally saved**, with `synchronization: "not_confirmed"`. They do not mean another device has received the note. Updates retain the account adapter's documented best-effort checks, not atomic compare-and-swap. No automatic write retry or exactly-once guarantee is provided. A lost/invalid response after a write returns `outcomeUnknown: true`; inspect the note/list before deciding to retry. MCP request IDs are not durable idempotency keys. Tests force a dropped response after a simulated server commit and verify no retry.

## Protocol scope and maintenance

The implemented subset is explicitly pinned to **2025-11-25** and **2025-06-18**: initialize/version negotiation, ready notification, ping, tools/list, tools/call, cancellation and stdio termination. An unsupported requested version receives a supported version; a client that cannot use it must disconnect. No 2026 protocol features, tasks, resources, sampling, prompts or full-spec conformance are claimed.

The existing Joplin MCP class was inspected. It is tied to the internal singleton tool registry and Joplin's semantic store; importing it would bypass the external account service. The supplied locked/offline runtime also does not contain the official MCP SDK. This increment implements a small tools-only wire layer with Node built-ins rather than modifying the core or dependency baseline. Tool inputs use explicit per-tool schemas, including the nested structures currently needed by the catalog; this is not a general JSON Schema engine. Before broader protocol/remote transport support, reconsider adopting a pinned official SDK outside the CLI fork rather than expanding this layer into a general framework.

Frames are bounded to 1 MiB; results to 2 MiB; queued output to 8 MiB; active tool calls to eight. Excess concurrent calls fail explicitly. Cancellation reaches the private API's AbortSignal. EOF/SIGTERM/SIGINT stop dispatch, abort pending calls and drain responses, with a five-second bound. Incomplete/invalid UTF-8 JSON frames fail without echoing input. Limits are deliberately finite; they are not an Internet-service denial-of-service guarantee.

**No network MCP listener is opened.** This is not an HTTP/OAuth gateway or a Cloudflare Worker deployment. Remote authentication, origin validation and transport behavior belong to a separately tested remote interface. A stdio configuration alone does not expose the service to hosted web clients.

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

A configured `semantic` block now enables meaning-based and hybrid retrieval in `search_notes` and starts a per-account indexer in this process. See [SEMANTIC.md](SEMANTIC.md). This process then owns a separate SQLCipher index and its key; it still never opens the core Joplin DB or needs the core DB/E2EE keys. Unconfigured clients retain explicit semantic-unavailable behavior. No public transport or authentication scheme was added.
