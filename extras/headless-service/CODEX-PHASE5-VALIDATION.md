# Codex — focused Phase 5 account operation

Date: 2026-09-21. Import only the new Phase 5 format patch onto a clean worktree based on the mapped public-history commit `b9692fc83684e00dce96e5e0a34ba01e5854334f` (or a verified equivalent). This is the mapped counterpart of historical original-source commit `52a13c639523447f4aa49c552fe7db421ef25f28`. Do not replay Phase 4, the popup fix or the rewritten snapshot root.
Read `MULTI-USER.md` and use the already built CLI/native dependencies.

The user explicitly backlogged encrypted/locked-note UI, physical mobile,
deployed HTTPS and actual PWA installation/relaunch. Do not perform those tests,
reset keys to construct a locked-note fixture, or make them blockers here. The
accepted Phase 3 plaintext and Phase 4 local workflow are not reopened.

## Safety and setup

Use **two approved disposable Joplin accounts**, separate encrypted profiles,
DB keys, API tokens and E2EE identities. Copies of already authorized independent
test profiles can retain their own identities. Never turn a copy of A into B by
resetting its key or reusing A's sync credentials. Confirm which sync targets and
accounts are actually used. The current personal core/web/index/Ollama and old
contaminated observers are not the test targets; leave them untouched.

This source package contains no credentials or profiles. If a second approved
account or its unlock material is unavailable, report that specific prerequisite;
do not silently repurpose the active account or claim native two-account success.
A fake second backend is not the real acceptance check.

Use the supplied config examples, distinct fixed core/web/clipper ports,
independent retry namespaces and per-account owner-only secret files. Add each
account's already approved semantic configuration and distinct SQLCipher path/key
where semantic search is enabled. Reuse the already approved model endpoint;
there is no requirement to download a model or rebuild the existing personal
index. An initial **new disposable account** index is expected and must be
identified as such; obtain approval for any remote disclosure of its content.

For a new profile, configure through `account-core.mjs ... import-config` using
controlled stdin, then initial `sync`, existing-key `decrypt`, and `status`.
Record before/after key identity/count without recording key material. This
wrapper has no enable/reset/default-profile command. Do not run setup commands
against a profile while a worker owns it. Existing configured profiles need no
repeat setup. All secret-bearing files remain local and untracked.

Start `node extras/headless-service/fleet.mjs /private/test-fleet.json`.
Record the clean source commit and platform. Check `fleetctl ... status`: two
running account workers with separate core PIDs. Readiness is not sync/index
completion. Verify each account reaches its intended notebook/known synthetic
note, not merely an HTTP 200 from some process on a port.

## Focused observations

1. **All shipped interfaces.** At A's and B's web origins, log in with their own
   web keys. Each notebook listing/read/keyword search must contain only its
   permitted account's synthetic data. A's key and session must fail at B's
   endpoint; B's known private note ID must not be readable through A. Test the
   analogous wrong clipping bearer and wrong MCP bridge credential. Through the
   account's MCP bridge, check tools/list, a permitted read/search and rejected
   injected account/endpoint arguments. Observe both accounts through the chosen
   MCP host, not by opening a second semantic owner.
2. **Writes and retrieval.** Create one synthetic Markdown note per account via
   the web, one selected-text clip per account, and a permitted MCP edit. Check
   stored content in the correct account and absence from the other account.
   Run semantic/hybrid queries through web and MCP once those disposable indexes
   are ready; record account-bound results and explicit unavailable/fallback
   behavior if a provider is inaccessible. No broad model-quality benchmark is
   needed. Existing native sync is the transport: normal stock-client receipt
   of one new synthetic note per account is sufficient, without repeating the
   long Phase 1 acceptance.
3. **Independent lifecycle.** Keep B connected and its core PID recorded.
   Restart only A. B's core, access and semantic owner must stay usable. A reopens
   its same encrypted profile and retains the synthetic content; old A web
   sessions/MCP connections are invalidated. Connect two MCP hosts/bridges to A,
   then close one: the other and A's web remain usable with one semantic owner.
4. **Unlock failure.** Stop A. Temporarily withhold its external DB-key file
   without editing/replacing the original key. Starting A must fail closed;
   B must remain usable. Restore the **same** key and explicitly start A.
   Record that no new E2EE or DB identity was created. Do not intentionally corrupt
   a real profile or require a destructive wrong-key reset.
5. **Disable/re-enable.** Disable A through the operator socket. After the
   command completes, old A web/MCP/clipper access is unavailable and its worker
   is stopped; B remains usable. Verify A's profile/index still exist. Restart
   the test fleet and verify A remains disabled. Enable A: reauthenticate and
   verify retained content under the same keys. Do not delete accounts or notes
   to demonstrate revocation. Already accepted in-flight saves may finish during
   draining; the implementation does not promise rollback.

An identical-note-ID negative test is already exercised by the synthetic source
suite. Do not rewrite native IDs or manufacture shared notebooks merely to repeat
it. Existing naturally shared IDs can be checked with their intended per-account
access, but shared content is not evidence of leakage by itself.

## Finish and report

Stop only the disposable test fleet or leave it running with the user's approval;
record the choice. Restore any withheld secret file. Record counts/statuses,
account routing, PIDs/restart observations, native key identity preservation,
semantic-owner count and the clean source commit. Preserve test notes unless
explicitly approved for recoverable trash; never purge profiles or the older
contaminated observer as cleanup. No application source change is expected unless
a concrete defect is found.

Return `chatgpt-phase5-codex-results.zip` with sanitized reports and public
synthetic fixtures. Include actual commands with secret/path redactions, direct
exit codes and failed/unexecuted observations. Exclude profiles, DBs, secrets,
cookies, raw authorization headers, private configs and payload-bearing logs.
Only include a new patch/incremental bundle when an actual source correction was
made. Source tests here use synthetic cores; report native/selected-host results
separately instead of treating them as inherited passes.
