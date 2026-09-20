# Phase 2B local-model and Codex results

Completed on 2026-09-20. The delivered Phase 2B increment was imported as `89c624b420de9ba0b585d6bb371b07e5306a028a` on `feat/headless-semantic-search`, parent `fe80f2a00f00293230c93c1f209243b329f3f6a8`. This corresponds to ChatGPT commit `a2924db75480af05ab18c95ad42655f6a341f557`. No application fixes, dependency changes, or repeated full builds were needed.

## Results

Native macOS Ollama 0.34.2 served BGE-M3 locally on an M4 Pro with 48 GiB RAM. Model digest: `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`; F16, 1024 dimensions, 8192 context. Ollama reported 100% GPU execution. The retained ARM64 OrbStack container accessed the loopback-bound server through `host.docker.internal`; no Joplin API port was published.

- Eight public-text probes: `PASS embedding-http-shape`, 1,354 ms and 121 reported input tokens.
- Created 24 synthetic notes in one new notebook: the original 20 plus four Japanese notes. Existing notes, core keys, and E2EE identities were preserved.
- Original ten fixed relevance queries: all expected notes ranked first; checker exit 0. After the Japanese indexing recovery described below, all three additional fixed queries also ranked their expected notes first; checker exit 0.
- Final index contained 29 eligible notes, including five retained notes, with no pending or failed notes after the explicit indexing cycle.
- The 8,444-byte long note produced four chunks. Actual Codex retrieval matched its last chunk, covering bytes 6351–8444. This demonstrates end-of-note retrieval under this chunk configuration, not general model-limit truncation behavior.
- Actual Codex CLI 0.155.1 semantic/hybrid observation exited 0. Four distinct checks passed: Chinese semantic and Malay hybrid queries found the guest-WiFi note; Japanese hybrid found the Japanese library note; English semantic found the garden-tail passage. Expected targets ranked first and all returned notes respected the notebook filter.
- Actual Codex provider-outage observation exited 0. With only Ollama stopped, hybrid search returned the expected guest-WiFi note and explicitly reported `executedMode: keyword`, semantic state `degraded`, reason `embedding_provider_unavailable`.

The English query about learning Japanese vocabulary retrieved its Japanese note at rank 1. Thus cross-language English-to-Japanese retrieval was observed. Chinese-to-Japanese retrieval was not separately measured. These small synthetic cases establish useful behavior for this collection, not broad multilingual retrieval quality.

## Finding for ChatGPT: checker readiness after newly added notes

The first Japanese three-case check exited 1 after 226 ms. It observed persisted readiness with 25 indexed notes rather than the expected 29: two Japanese targets were missing from the top ten, while the English-to-Japanese target ranked first. The failed attempt is retained in the accompanying report.

The supplied standalone one-cycle indexer then exited 0 with 29 indexed notes and no pending or failed notes. Repeating only those same three cases, without changing notes, queries, expectations, or application code, passed in 239 ms with all expected targets ranked first.

This suggests a readiness race in the acceptance procedure: the checker accepts existing `ready` state before newly appended notes have necessarily been processed. Please assess whether the checker should wait for the expected notes or document an explicit indexing cycle before relevance checks. No source fix was made here.

## Scope and retained state

Inference stayed on this Mac. A separate private SQLCipher semantic key was created; the MCP adapter remained read-only. No explicit sync command or fresh live-server synchronization check was run. The retained core has automatic synchronization configured, so this is not a claim that no background synchronization occurred.

Codex registration was invocation-only and ephemeral. No permanent Codex configuration or Ollama autostart was added. Synthetic notes and the private derived index are retained for continuation. The temporary core is stopped after checks; Ollama is restored to its manually started loopback service.

The archive includes only this report, sanitized summaries, and generated synthetic corpora. It excludes profiles, databases, keys, API tokens, credentials, and private configuration. Raw Codex event logs remain local under `chatgpt-work/phase2b-local/`; the accompanying final-result summaries record the selected-host checks.

Phase 2B's requested local-model and selected-host observations passed for this tested scope, with the initial readiness failure explicitly recorded. No subsequent phase was started.
