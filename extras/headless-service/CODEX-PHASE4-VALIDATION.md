# Codex — focused Phase 4 acceptance and retained Phase 3 check

Date: 2026-09-21. Import the Phase 4 patch onto a clean branch already containing the repaired Phase 3 changes and popup fix from historical original-source commit `c9101462ef7a79521c352d8bc7b93546b7adeb1f`. Its mapped public-history commit is `cc3555f00ffd5ef817ad8bbed894363374a998fa`; use that commit or a verified equivalent as the base. The popup fix is already incorporated in the snapshot baseline. Do not apply it twice. No current browser/core/HTTPS acceptance is claimed by the delivery. Preserve unrelated work.

## First: close the earlier Phase 3 content observation separately

Read the supplied `ORDINARY-CLIENT-SYNC.md`. The altered disposable observer copy is unusable and
must not be reused, synchronized or automatically deleted. The report records that a worker ran
`e2ee enable` there by mistake. Active and retained source profiles were not targeted. Whether any
upload happened after that mistake is unobserved; do not replace that limitation with an assumption.

Use a fresh disposable copy of the untouched ordinary-client profile with its existing E2EE identity.
Copy only when the source profile is stopped or use a known-consistent stopped snapshot; do not run
another process against the source profile. Keep private paths and credentials local to the operator.
Record the chosen source and copy as private operational state, not in the returned report.

Check the installed CLI's help/source to establish the **decrypt** invocation before running it.
Do not run `e2ee enable`, `e2ee disable`, reset encryption, create a master key, replace a DB key, or
edit the active/source profile. Unlock with the existing identity/password through the already
approved mechanism. If the correct existing secret is unavailable, report that exact blocker rather
than provisioning a new identity. Do not put credentials into ChatGPT artifacts or result logs.

Read these two already-created clips after normal sync/decryption:

- `d3e98fcc4557e543ec21c39917928a46`
- `91d230b92befd4b2516cc2e0db33731a`

Compare title, notebook, source URL and literal Markdown-escaped synthetic body against the earlier
handoff. Record the actual plaintext observation and unchanged master-key identity/count using
sanitized identifiers, not secret material. Do not create another clip or force a one-shot headless
upload. This closes only the missing content observation; the previous browser/permission/retry and
search results remain separate. No repeat of the long Phase 1 test is required.

## Phase 4: use the installed core, not a second profile owner

Keep the working headless daemon/API and existing identities. No reinstall, model change, full index
rebuild or profile/key migration is needed for this application-only patch. Follow `WEB.md` to create
one separate web access key and stable namespace, reuse the account configuration and start the web
entry. Start read-only first when checking access to an existing collection. Use only an approved or
disposable notebook for writes. The web key has account-level web scope, unlike the notebook-scoped
clipping key.

For semantics, stop only the previous semantic owner before transferring its existing configuration
to web; do not launch a second owner of the same index. For MCP plus web, set `stdio: true` and have
the chosen MCP host launch `web.mjs` instead of `mcp.mjs`. That host's stdin lifetime controls web
availability. Test keyword-only first when a semantic owner cannot safely be transferred now; report
semantic acceptance pending rather than changing database paths or rebuilding silently.

Run the local application suites using the existing installed markdown-it package. An absolute
`JOPLIN_WEB_MARKDOWN_MODULE` can point at a relocated existing pack, without installing another copy.
Record exact runtime, source commit, exit status, pass/fail/skip counts. Skipped native tests are not
new passes. Existing core build/native evidence is historical, not a substitute for the new web path.

## Permitted-browser observation

Use a browser permitted by the operator/administrator. Do not disable or bypass managed URL or
extension restrictions. Record browser/version, desktop/mobile viewport, and the actual route.
Loopback observation does not establish deployed remote HTTPS.

1. Open the shell signed out. Confirm note endpoints reject unauthenticated access. Sign in with the
   separate web key. Confirm it disappears from the input, no token appears in URLs, and only paged
   note summaries load until a note is selected. Browse notebooks and more than one notes page.
2. Read a synthetic Markdown note containing the languages in use, code, ordinary punctuation, a
   table, a remote image and literal HTML. Confirm source remains intact. Preview is a limited inert
   Markdown subset, not Joplin plugin/resource fidelity. No image/attachment/network fetch should be
   caused by reading. HTML notes and oversized/locked/encrypted notes must not become editable.
3. In the approved notebook create one synthetic Markdown note. Include an inert image reference.
   Confirm the original source is stored, no unwanted resources are created, keyword search finds it,
   and the existing semantic/hybrid engine finds it when enabled. Confirm read-back and UI report local
   saving without claiming synchronization. A title-only edit should leave a CRLF body unchanged.
4. Using a controlled response-drop proxy or browser test route, let one `/api/write` commit upstream
   and consume its successful response before dropping the downstream response. A pre-request outage
   is a different case. Confirm the draft remains and its submitted fields lock. Retry the exact request:
   it must reconcile the same note, with one create and no unintended duplicate. Test an actual offline
   failure separately and confirm reconnecting alone does not automatically submit a write.
5. Exercise explicit Discard draft: deny confirmation first, then accept. Only page state should clear;
   no note deletion occurs. Inspect existing notes before recreating an uncertain operation. A server
   restart during a pending create should retain receipt-based reconciliation; do not change namespace.
6. With the web note open, edit that same synthetic note in a normal stock client and synchronize.
   Wait until the web service can observe the newer content, then save the stale web draft. Confirm
   stale rejection and retained text. Compare latest, merge deliberately, select the new base, then save.
   This is the observed-stale case. The documented check/write race remains **non-atomic**, and the
   result must not be reported as an absolute concurrent-write/lost-update guarantee.
7. Confirm a note created/edited through this actual web path reaches a normal client through the
   existing automatic headless synchronization and can be read as plaintext under the existing E2EE
   identity. Record client and sync target. Do not substitute seeing ciphertext for reading the note.
8. Observe session expiry/reauthentication with a draft retained in the same page. On successful
   sign-out, note/comparison/search state must clear and the old session must fail. Check mobile
   layout, keyboard/focus behavior and iframe rendering. Check that the browser stores no note/draft
   data in localStorage, sessionStorage, IndexedDB or Cache Storage.

A separate automated synthetic-browser check is supplied for an environment already equipped with
Python Playwright and a permitted installed Chromium:

```sh
export CHROMIUM_PATH=/absolute/permitted/chromium
export JOPLIN_WEB_MARKDOWN_MODULE=/absolute/installed/markdown-it
python3 extras/headless-service/tests/web-browser.py /private/synthetic-web-results
```

That runner uses synthetic in-memory HTTP data, not the live core or your profiles. It was blocked at
navigation in ChatGPT's sandbox; its individual assertions have not been observed passing there.
Keep its scope distinct from steps 3, 6 and 7 above. Do not install or bypass managed software just
to make the optional runner work; manual permitted-browser observations are usable evidence.

## HTTPS and PWA deployment observation

Only claim a remote route after using the configured HTTPS origin from the actual remote browser.
Use a dedicated root origin, preserve Host/Origin and cookies through ingress, keep the raw core API
private, disable proxy POST retries and note-response caching, and avoid credential/body logs.
Confirm Secure HttpOnly host-only cookies, correct origin restrictions and an unauthorized request.
Use the manifest/install path in that chosen browser/OS and report whether installation and relaunch
actually work. No service worker or offline note mode is promised. Installing does not remove the
need for network access or make page-memory drafts durable.

## Return report

Report each observation as passed, failed or not run, with source commit, actual browser/client/route,
sanitized synthetic note IDs and command exit statuses. Include only relevant redacted logs or
screenshots of synthetic content, any focused corrective patch and a clean Git status. Never upload
profiles, databases, configs containing secrets, tokens, passwords or keys. Preserve the old observer
mistake and the Phase 3/Phase 4 acceptance distinction. Do not declare Phase 5 complete.
