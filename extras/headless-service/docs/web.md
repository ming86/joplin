# Thin, single-account web frontend

The local browser/core acceptance checks passed on 2026-09-21. The real-browser, stock-client and edge observations are recorded in the local reports `BROWSER-RESULTS.md`, `STOCK-WEB-RESULTS.md`, and `EDGE-RESULTS.md`. Encrypted/locked-note UI, physical mobile, deployed HTTPS, and actual PWA installation/relaunch remain unobserved and are deferred in [backlog.md](../backlog.md). This local workflow does not establish atomic concurrent-write protection.

## What this increment provides

Run `web.mjs` beside the existing profile-owning headless client. It uses the account layer and
private Data API; it never opens the Joplin database. The browser can list notebooks and paginated
note summaries, read a selected note, search, create a Markdown note, and edit its title/body.
The service has one configured account. The browser cannot choose another account, worker URL,
semantic path, or token. Read-only account configuration is enforced even against forged requests.

The list omits bodies and requests 30 notes per browser page. Notebook browsing is scoped to the
selected notebook; search is explicitly across all notebooks. Keyword queries retain the existing
Joplin search behavior. Semantic/hybrid search uses the existing optional semantic engine and its
bounds; an unavailable engine is reported explicitly. Hybrid fallback identifies keyword execution.
No new embedding model, provider, vector database, core format or dependency manifest is added.

The editor preserves supported Markdown source, rather than converting rendered HTML back to
Markdown. New notes use an empty, receipted placeholder POST followed by a title/body PUT. This
avoids sending Markdown images through Joplin's media-fetching creation route. An interrupted
create can leave a visible `[Pending web note]`; a retry finishes that same placeholder when its
receipt and content still match. It never silently overwrites an externally edited placeholder.

## Start with the existing account configuration

Prerequisites: the already working headless CLI/private API, Node 22 compatible with this source,
and `markdown-it` 13.0.2 already installed for `packages/renderer`. No reinstall is needed on the
prepared builder. The renderer resolves that workspace dependency. A separate relocated runtime
may set `markdownModule` to the absolute path of its installed `markdown-it` package or official
bundled CommonJS distribution. It is trusted startup configuration, not browser input.

Reuse the existing private MCP/account JSON from Phase 2B. Its `allowWrites` controls both web and
optional shared MCP writes; the default is false. Keep the core API token in its existing owner-only
file. The web process needs that API credential, not the Joplin DB key or E2EE password. Enabling the
optional semantic component separately requires its existing semantic key/configuration.

Create a **different** web access key (32–256 URL-safe characters) in a new owner-only file outside
source/deliverable directories. The process explicitly refuses to reuse the broad core API token.
Choose one stable, randomly generated 32-hex namespace, distinct from the clipper namespace.
Preserve it across restarts and token rotation. Copy `scripts/web.example.json` and configure:

```json
{
  "accountConfigFile": "/private/existing-mcp-account.json",
  "webTokenFile": "/private/web-access-key",
  "namespace": "YOUR_STABLE_RANDOM_32_HEX_NAMESPACE",
  "port": 4120,
  "publicOrigin": "http://127.0.0.1:4120",
  "stdio": false,
  "sessionMs": 3600000
}
```

The placeholder namespace is deliberately invalid until replaced. All file paths are absolute.
Protect credentials using the existing private-file/secret-delivery arrangement; do not put them
in Git, shared Drive artifacts, browser URLs, or content-bearing logs. Do not overwrite an existing
key file while preparing a test. New random values can be generated locally with Node's
`crypto.randomBytes`, using `fs.writeFileSync` with `mode: 0o600, flag: 'wx'` for a new file.

```sh
node /absolute/repository/extras/headless-service/web.mjs /private/web.json
```

Open the configured origin and sign in with the separate web key. This is not a Joplin Server
password or an E2EE unlock form. The key is cleared from the form after submission. The server
exchanges it for a random, HttpOnly, SameSite=Strict session cookie. Sessions live only in the
web process, expire according to `sessionMs` (default one hour, maximum one day), and disappear
on server restart. Cookie expiry is server-enforced, not a durable browser authentication store.
There is a cap of 32 live sessions and bounded login/API rates. This is not an enterprise login
or user-administration system. The web key grants the configured account's web read/write scope,
not the clipper's narrower notebook-only scope.

## Sharing semantic ownership with MCP

Only one process may own the configured semantic database. Do **not** leave an independently
launched semantic MCP owner running and point another web process at that same DB.

For web alone, use `stdio: false` and let this process own the existing semantic runtime.
For web plus one stdio MCP host, use `stdio: true` and configure that host to launch the command
above instead of `mcp.mjs`. The web gateway and MCP session then share one account service and
one semantic engine. There is no second local RPC broker or separate semantic service.

Closing that MCP connection's stdin shuts down **both** web and MCP. The host controls their
lifetime; multiple independent host launches must not each open the same index. Without semantic
indexing enabled, existing keyword-only clients can continue separately against the private API.
Clipping can also continue through its own existing listener; it does not open the semantic DB.
Do not stop or replace the core profile owner just to change the surrounding web/MCP launch.

## Network boundary

The listener binds only `127.0.0.1`. Loopback HTTP is for local testing. Any non-loopback browser
origin requires HTTPS; insecure LAN/public HTTP configuration is rejected. Use a dedicated origin,
not another application's untrusted content origin. Remote operation needs the operator's TLS
reverse proxy/tunnel to this web listener, **not** to the private Joplin Data API.

Set `publicOrigin` to the exact external origin, with no path/query/fragment. Preserve the original
Host, Origin, Cookie and Set-Cookie headers. Serve this app at that origin's root; path-prefix
hosting is not implemented. Forwarded-host/user headers never establish trust. Do not rewrite a
wrong incoming Host into the allowed one as an authentication shortcut. Disable automatic proxy
retries of write POSTs and response caching. Do not log cookies, credentials, request bodies or
note responses. Web-key login itself must travel over HTTPS remotely.

The gateway checks exact Host and request Origin, requires a same-origin custom header for every API call and grants no CORS access. HTTPS responses use Secure `__Host-` cookies. Static files are an explicit allowlist; arbitrary filesystem and Data API routes are not exposed. API responses are `Cache-Control: no-store`; static shell assets are revalidated. CSP restricts scripts and network requests to the application, denies framing of the app and allows only the fixed preview stylesheet hash. These controls are implemented, but a real external TLS route has not been tested. Any configured proxy/edge provider that terminates TLS can see the transported note content.

## Reading, editing and preview boundaries

Supported editing is Markdown (`markup_language: 1`), body at most 256 KiB UTF-8 and title at most
1,024 characters. HTML/other formats and larger readable notes are shown as source, read-only.
The existing private adapter's response limit still applies (default 8 MiB of JSON). Encrypted,
locked or deleted notes are not exposed as editable plaintext. The web UI does not silently
convert unsupported formats or truncate and save a partial note.

Preview uses the repository's pinned `markdown-it`, not the whole Joplin renderer/plugin stack.
Basic headings, emphasis, code, tables and literal text render. Raw HTML is escaped; images are
inert placeholders; links are inert text with a destination tooltip. Attachments, internal note-link
navigation, remote images, rich-text editing, math/diagram plugins, attachment upload and complete
Joplin rendering fidelity are **not** implemented in this increment. Their source remains intact.
The preview also uses a sandboxed iframe. No browser preview is fetched from a remote service.

Unchanged source survives a read/save round trip. A title-only change preserves the original body,
including CRLF; actual edits of a uniform-CRLF body retain that convention. Editing a mixed-newline
body through a textarea may normalize its line endings; do not treat arbitrary byte files as this
editor's format. The supported document is Unicode Markdown, not a binary-file editor.

## Save, retry and concurrency

A success means the requested content was read back from the local headless client. The UI says
“Saved locally” or “Requested content confirmed locally”, **not** “synchronized”. The API reports
core reachability, semantic state, and current sync and decryption activity. Its sync report is
process-wide and does not confirm that a particular local write has synchronized.

Each create operation has a stable ID and content receipt. After a lost response the page keeps the
same operation and immutable submitted fields; “Retry same save” sends exactly that request. A
read-back match confirms an already completed update without a duplicate PUT. No automatic retries
are performed. This is content/receipt reconciliation, not exactly-once execution. Changing the
namespace or permanently purging the receipted note removes that create replay guarantee.

Failed or uncertain saves retain the page's draft. Copy can preserve it separately. **Discard draft**
requires confirmation, clears only that page's draft/retry state, and never deletes a Joplin note.
After discarding an uncertain operation, inspect Joplin before creating another copy. An abandoned
placeholder may need deliberate cleanup in a normal client; the web app does not delete it for you.
A session expiry prompts reauthentication without silently discarding a draft still in the page.

Updates compare a fingerprint of the readable note immediately before writing. An observed newer
version yields a stale-note error and retains the draft. Compare latest, merge manually, and explicitly
select the newer base before saving. This gateway serializes its own writes per note, but it does
**not** have an atomic compare-and-swap transaction with Joplin. A stock-client synchronization, MCP
write, another web process, or other API writer can race the check and be overwritten. One regression
intentionally demonstrates this limit. Do not rely on it for simultaneous collaborative typing.

## Browser retention and PWA path

The browser holds the selected note and draft in page memory. It does not create a full Joplin replica,
IndexedDB database, persistent draft store, offline write queue or service-worker note cache. Closing,
reloading, crashing or losing that page can lose unsaved or uncertain retry state. The leave-page
warning is best effort, not durable protection. Successful logout revokes the session and clears
note, comparison and search state; clipboard contents remain outside the app's control.

The shell includes a web manifest, 192/512 icons from the repository's existing icon, responsive CSS
and an install prompt button where the browser supplies that event. There is deliberately no service
worker or promised offline shell/notes. A manifest and icons are not an observed OS installation.
The 2026-09-21 local run observed desktop and phone-sized browser layouts. Physical-device behavior, deployed HTTPS, actual installation/relaunch, and locked-note UI remain unobserved in [backlog.md](../backlog.md).

## Tests

On the prepared repository, use its already installed dependency. For a relocated pack, set the
following environment variable to that pack's markdown-it module; it is a test-only locator:

```sh
export JOPLIN_WEB_MARKDOWN_MODULE=/absolute/installed/markdown-it
node --test --test-concurrency=1 extras/headless-service/tests/web*.test.mjs
node --test --test-concurrency=1 extras/headless-service/tests/*.test.mjs
```

The new controller/service/HTTP/process tests use explicit fake DOM or synthetic HTTP core data.
They exercise the production web entry/adapter and actual pinned Markdown parser, but not actual
Joplin persistence/E2EE, a real browser's security enforcement, or a live embedding model. Existing
native tests require the existing documented native runtime variables. Skips must remain recorded.

`tests/web-browser.py` is a Chromium acceptance runner against a synthetic HTTP core. It was blocked before navigation in this sandbox (`ERR_BLOCKED_BY_ADMINISTRATOR`), so its assertions did not run. This is separate from the manual local browser/core acceptance summarized above.

References for deployment behavior: MDN's PWA installability guide and Set-Cookie reference:
https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
