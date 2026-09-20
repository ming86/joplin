# Selected-text remote clipping

This external service adds a deliberately small capture workflow: selected or pasted **plain text**, title, source URL and one configured notebook. The Joplin CLI/core, its database and dependencies are unchanged. Existing MCP and semantic processes can remain separate; this service never opens their databases or owns an embedding index.

## Start the service

Copy `scripts/clipper.example.json` to an absolute private configuration path. Set the existing core Data API URL and its owner-only `apiTokenFile`. Create a separate random `clipTokenFile` (at least 32 URL-safe characters, mode 0600). This token is for clipping only; never enter the raw Joplin API token into the browser. Generate a stable random 32-hex `namespace` once and keep it with the service configuration. Changing it changes the operation-to-note mapping and can defeat retry reconciliation. Rotating the clipping token does not require changing the namespace.

Set `notebookIds` to actual allowed destinations, `port` to an unused port (example 41190), and `allowedOrigins` to the extension origin displayed by the popup. Obtain notebook IDs using the existing trusted application interface. No user-account provisioning or E2EE reset is needed.

```sh
node /absolute/repository/extras/headless-service/clipper.mjs /private/clipper.json
```

The listener binds **127.0.0.1 only**. For access from another machine, put an HTTPS reverse proxy/tunnel in front of it. Set `publicOrigin` to its exact HTTPS origin; forward either that Host or the internal loopback Host. Mounting at `/clipper/` is fine when the proxy strips that prefix before forwarding. Do not expose the raw Data API. Configure the proxy not to log Authorization or bodies; preserve Authorization and Origin; disable proxy-side POST retries. This implementation does not configure Cloudflare/OAuth or claim a tested public deployment.

The process accepts the separate bearer credential, enforces the destination allowlist, rejects unexpected Host/Origin and arbitrary routes, and limits input and request volume. The optional origin permission is an additional browser boundary, not a substitute for authentication. Non-browser calls with no Origin still require the bearer. Notebook names are the only listing exposed. No generic read, update or delete endpoint exists.

## Load the Chrome-compatible extension

Load `clipper-extension/` as an unpacked Manifest V3 extension in a browser that permits development extensions (Chrome 114 or newer for the used APIs). No extension package installation or build is needed. The popup displays `chrome-extension://<extension-id>`; copy that exact value into the server's `allowedOrigins` and restart the service after a configuration change.

Open an ordinary HTTP(S) page, select text, and invoke the extension. Enter the clipping endpoint (not the Joplin Data API) and the separate clipping token. Press **Allow endpoint and load notebooks** and accept the browser permission prompt. Review the title, selection and URL, choose a notebook, then save. Remote endpoints require HTTPS; loopback HTTP is allowed for local testing.

Host permission is requested for the selected scheme/hostname. Chrome match patterns cannot restrict that permission to one port or path; actual requests still use the configured exact base URL. This is not an all-sites content-script permission. `activeTab` and `scripting` read the page only when invoked; restricted browser/store pages are not capturable.

Ordinary endpoint preferences are in `chrome.storage.local`. The bearer and pending request are in **chrome.storage.session**, restricted to trusted extension contexts. They survive popup closure, but not browser restart, extension reload/disable/update, or session clearing. They are not sent to Chrome sync and are not intentionally persisted to disk by this extension. This is session-scoped retry support, not durable offline capture. Keep the browser session open for an uncertain submission; losing the session loses the retry record. Inspect Joplin before creating a new clip after such a loss.

No persistent note cache, full local Joplin DB or model is present in the browser. Unsubmitted edits before pressing Save are just popup state. Closing the popup can lose those edits. On Save, the immutable operation is stored in session state **before** the network request. Reopening a popup restores an uncertain request and locks its content/destination to avoid a changed retry. The token can be replaced, and endpoint permission can be regranted without discarding the operation. Discard is explicit and warns that the note may already exist.

## API and retry contract

```
GET /v1/notebooks
Authorization: Bearer <clip token>

POST /v1/clips
Authorization: Bearer <clip token>
Content-Type: application/json

{
  "operationId": "<random 32 lowercase hex characters; reuse on retry>",
  "notebookId": "<allowed Joplin notebook ID>",
  "title": "Page title",
  "text": "Selected literal text",
  "sourceUrl": "https://example.test/article"
}
```

The service derives a note ID from account ID, stable namespace and operation ID, and writes an input fingerprint in the note's `source` property in the **same Joplin POST**. Joplin's pinned POST path with an explicit ID uses `isNew=true`, so a collision is not a PUT/update. No extra plaintext receipt database is introduced. The `source_url` property records the reviewed HTTP(S) URL; the page is never fetched by the service.

A normal response is HTTP 201; replay is HTTP 200 with `replayed: true`. Both report `saved: local` and `synchronization: not_confirmed`, not that every other client has received it. After a lost response, retry the exact operation. The service looks up the existing receipt and returns its note ID without changing its body. Same-operation concurrent calls coalesce locally. Other processes/late commits can produce a retryable unknown result; uniqueness is anchored by the explicit note ID, not a distributed exactly-once promise.

A reused operation with different content, altered receipt, moved note, trash state, locked or encrypted-unavailable note returns conflict. It does not resurrect or overwrite that note. **Permanently purging the note also removes its receipt**; a later replay can recreate that ID. Receipts are not irrevocable audit records. Treat replay after permanent deletion or namespace changes as outside the deduplication guarantee. Stop/restart retains receipts because they live in Joplin's database.

Input limits are 512 UTF-8 bytes for title, 128 KiB for text, 4096 bytes for source URL, and 1 MiB for the HTTP request. Only allowed properties are accepted. Source URLs exclude credentials and fragments; review query strings for sensitive values before sending. HTML, Markdown input interpretation, images, files, OCR, tags and article extraction are not enabled. Plain-text Markdown punctuation and HTML delimiters are encoded as literal text so Joplin's note-creation media extraction does not fetch embedded URLs. No claim is made about private content capture without its user's approval.

## Verification and scope

Run `node --test extras/headless-service/tests/clipper.test.mjs` for protocol/service/client-helper tests. With the existing native runtime configured, include `clipper-native.test.mjs` in the full suite. The native test runs a real clipping process, actual encrypted core, real lost-response proxy, a service restart, one-note reconciliation, no-resource checks, FTS, encrypted semantic fixtures and automatic filesystem E2EE sync to the same binary's normal client mode. It uses newly generated disposable profiles and secrets, not existing accounts.

Selected-browser extension loading, actual permission prompts and remote HTTPS routing are separate acceptance observations. Browser UI tests using stubbed extension APIs do not substitute for them. No unmodified upstream client or public deployment is claimed by the native clipping test.
