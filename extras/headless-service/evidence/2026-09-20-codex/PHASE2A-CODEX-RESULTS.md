# Phase 2A selected-host observation

PASS: Codex CLI 0.155.1 interoperated with the Phase 2A stdio adapter and existing encrypted ARM64 headless core. The Codex process exited with code 0 directly observed.

## Imported source

- Branch: `feat/headless-mcp-stdio`
- Real-history commit: `fe80f2a00f00293230c93c1f209243b329f3f6a8`
- Parent: `79ef3977c3ccbd5e2c40720ac1a6e169eac7d40a`
- Corresponding returned commit: `037420aa66115c71033f587543b4ca1192e2a33a`
- Applied the supplied format patch once: 14 files, 783 insertions, entirely under `extras/headless-service/`. No snapshot-root merge, new implementation fixes, dependency changes or rebuild.

## Actual host observation

An ephemeral Codex session used invocation-only MCP configuration launching `docker exec -i` into `joplin-phase1-runtime`. No permanent Codex configuration was changed and no raw API port was published. The adapter used the existing token via a private file, with `allowWrites: false`.

Codex reported these exposed tools: `get_status`, `list_notebooks`, `list_notes`, `search_notes`, `get_note`. `create_note` and `update_note` were absent. The JSONL execution record confirms successful calls to `get_status`, `list_notebooks`, keyword `search_notes`, and `get_note`. Search returned the existing synthetic target and the subsequent read returned that same note. `list_notes` was discovered but not called. Semantic status remained explicitly unavailable.

This closes the requested short Codex CLI interoperability observation. It does not claim GUI-host testing, full MCP conformance, write-mode host acceptance, remote hosting or semantic indexing. No note mutations, E2EE reset, dependency install or repeated long Phase 1 acceptance run was performed. Private profiles, tokens and keys are excluded from the results package.

Evidence: `runtime-check/phase2-codex-result.md`, `runtime-check/phase2-codex-events.jsonl`, and `runtime-check/phase2-runtime-notes.md`.

The temporary core was stopped after the check. Its detached process remained as a defunct record under container PID 1; the private cleanup helper was corrected to recognize that terminated state and reported `PASS phase2-core-stopped`. This was a runtime-helper correction, not an application change or evidence of a directly captured core exit code.
