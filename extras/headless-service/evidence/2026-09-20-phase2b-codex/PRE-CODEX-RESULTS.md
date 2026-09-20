# Phase 2B pre-Codex runtime results

The retained `joplin-phase1-runtime` container reached the host-local Ollama service through OrbStack's `host.docker.internal` alias. The container stays in bridge networking; no raw API port was published, no host-network mode was used, and no Ollama binding was changed.

The private semantic configuration uses `allowWrites: false`, a newly generated owner-only semantic key, a new derived SQLCipher DB path, and the existing `/opt/headless-native/node_modules/sqlite3` binding. `host.docker.internal` is a non-loopback container-to-host hop, so the config explicitly sets `remoteProcessing: true` and `allowInsecureHttp: true`; it remains a local-machine transport, not a third-party provider.

## Public-text provider probe

- Model: `bge-m3:latest`
- Deployed digest: `sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`
- Configured dimensions: 1024
- Eight fixed public probes: 1,354 ms total, 121 reported input tokens
- Synthetic expected ranks: `[1, 1, 1, 1]`; top-1 hits: 4/4
- Result: `PASS embedding-http-shape`

This validates common-API shape and the fixed public ranking check only; it is not corpus relevance or model truncation certification.

## Fixed 20-note corpus retrieval

Exactly 20 fixed synthetic Markdown notes were created in one new notebook. Existing notes and E2EE material were retained. The reference checker closed its semantic owner and exited 0 after 2,998 ms.

- Indexed eligible notes: 25 (20 new synthetic notes plus 5 retained eligible notes)
- Known successful usage: 6,984 input tokens, 28,991 prepared bytes, 25 requests
- Fixed English relevance cases: 10/10 top-10 hits, all rank 1
- Per-query semantic latency: 28–67 ms
- Result: `PASS semantic-retrieval-check`

The retained profile has a non-disabled sync target configured. No explicit sync command or fresh live-server sync check was run, so this establishes a configured retained local profile rather than a fresh live-sync proof.

## Long synthetic input

The fixed balcony-garden note has an 8,444-byte body. Under the configured 2,400-byte chunk size and 240-byte overlap it produced four chunks, the largest prepared chunk was 2,400 bytes, and the final chunk covered the end of the body.

## Japanese append and retrieval

Four further fixed synthetic Japanese Markdown notes were appended to the same new notebook. The original 20-note corpus and its result were not recreated or changed.

The first three-case checker invocation was preserved as an operational sequencing failure: it observed the persisted store as ready at 25 indexed notes while the newly appended notes had not yet become visible to its searches. Two Japanese-target cases were absent from the top 10 and the English-to-Japanese case was rank 1; the reference child exited 1 after 226 ms. This is an observed timing condition, not a claim about its cause or a source-code defect.

The supplied one-cycle indexer then exited 0 and reported 29 indexed notes, no pending or failed notes, and 42 successful requests. One retry of only the three Japanese cases then passed: all were rank 1, with 36–89 ms semantic-query latency; the reference child exited 0 after 239 ms. The semantic owner closed after each checker; the private core stayed ready for the selected-host check.
