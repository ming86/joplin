# Semantic search

The Phase 2A read-only selected-host check passed on Codex CLI 0.155.1 with directly observed exit 0. Its exact supplied report is under `../evidence/2026-09-20-codex/`. No fixes were needed. That does not claim write-mode host testing or full MCP conformance.

This increment adds a separate encrypted derived index, an OpenAI-compatible HTTP embedding transport, incremental indexing and semantic/hybrid search. The index is separate from Joplin's core store and leaves the original FTS and E2EE behavior unchanged. It introduces no disk/volume encryption, blanket attachment policy, cloud ingress, LLM chat, reranker or vector server.

## Operational setup

Start with the existing encrypted core and its private API. Copy `scripts/semantic.example.json` to a private absolute path and set the account, existing API token file, semantic database location, SQLCipher binding and secrets. The sample illustrates an OVMS `granite-embedding-311m-multilingual-r2` endpoint at `http://embedding-service:9000/v1` and declares a fixed 384-dimensional embedding space. Its `space.revision` is an operator version label, not a verified weights hash; change it when the served model or embedding behavior changes. The sample's `apiKeyFile` is a placeholder path for a private file containing only the raw token, without a `Bearer ` prefix. No live token is included.

The sample describes one account. For multiple accounts, retain a distinct core profile, API token, semantic database path and semantic key for each account. Keep each account's index in its own derived database.

The semantic worker reads Joplin's local event feed every five seconds and processes persisted note changes and retries. This reads the core's event API; it does not run Joplin synchronization every five seconds. The core's remote-poll interval is configured independently; see [the container guide](../deploy/README.md#core-profile-and-key) for its default and completion-based scheduling.

Generate **a separate 32-byte random semantic DB key** as 64 hexadecimal characters plus an optional newline, and deliver it as an owner-only file (`0600`) through your existing secret-delivery mechanism. Keep this key/recovery copy separate from index backups; file permissions alone do not protect a copied key beside its DB. Do not reuse, regenerate or reset the existing Joplin E2EE identity or core database key. The MCP process needs its semantic DB key and the core API token, not the core's database or E2EE key.

Set the archive's `LD_LIBRARY_PATH` as described in its `README-run.txt`. Use `semantic.sqliteModule`, or the existing `JOPLIN_HEADLESS_SQLITE_MODULE`, to identify the complete compatible SQLCipher-enabled sqlite3 Node package. There is no plaintext/native-binding fallback and no `yarn install` step.

For remote inference set the desired common-API `baseUrl`, `model`, `remoteProcessing: true`, and (where needed) an `apiKeyFile` inside `semantic.embedding`. Token files are owner-only; the transport trims the file contents and sends the token as a Bearer credential. The sample opts into remote processing and insecure HTTP for its private OVMS endpoint. Only explicit trusted startup configuration chooses destinations; MCP arguments cannot supply backend URLs, keys or account identities. A non-loopback endpoint requires explicit remote consent; an insecure private HTTP address additionally requires `allowInsecureHttp: true`. A loopback proxy can itself forward remotely: these declarations are operator policy, not proof of where inference happens.

Run as before:

```sh
node /absolute/repo/extras/headless-service/mcp.mjs /private/mcp-semantic.json
```

The process asynchronously polls and indexes while serving MCP. It is **one semantic DB owner per account**: do not launch several such MCP processes against the same DB. Additional read-only MCP configurations without semantic enabled can still use core keyword search. The [managed-account gateway](multi-user.md) routes requests to the account worker that owns its semantic engine.

On orderly shutdown the indexer is cancelled and its DB/lease closed. After an unclean kill a `semantic.sqlite.lock/owner.json` directory may remain. Confirm that no process owns that DB before manually removing this directory; there is no unsafe automatic takeover of a possibly live owner. Never remove the actual DB to recover just a stale lease.

A missing/wrong key, foreign-account DB, unsupported native binding or incompatible configuration reports semantic unavailable while leaving the private core and keyword interface usable. It does not overwrite the protected index or silently create a plaintext replacement. Ordinary MCP configuration without `semantic` retains Phase 2A behavior.

## Provider and model contract

The common request is `POST <baseUrl>/embeddings` with `model`, string-array `input` and `encoding_format: float`. Batches are bounded. Results are reassembled by index and checked for count, dimensions, finite/nonzero vectors and usage shape. Model-specific query/document prefixes are applied exactly once. L2 normalization is the default. No API SDK, tokenizer, model weights or ONNX runtime is added to the fork.

Transport has timeouts, cancellation and redirect refusal, with no adapter-imposed response byte limit. It makes one attempt per request. The indexer persists pending work and retry deadlines; provider rate-limit/outage failures pause further document work with bounded backoff and respect bounded `Retry-After`. Hybrid requests fall back to keyword search with explicit status. No query vector from an unrelated model is substituted.

Endpoint hosting/credentials are operational configuration. Index identity includes the embedding space fingerprint, operator revision, dimensions, preparation/normalization, chunker settings and requested model alias. Changing one of these incompatibly requires rebuilding or replacing the derived index. An in-place rebuild uses explicit `semantic.rebuild: true` and requires the account's core API to remain available while no semantic owner uses that database. Managed fleet configs reject `rebuild: true`; a separately managed migration can use the account database while the fleet keeps the core running with that account's semantic feature disabled. Alternatively, stop the fleet and replace only the derived semantic database, as in the two-account Granite switch. Keep each account's database path and key, and migrate accounts separately. Joplin profiles, notes, core databases and E2EE identities are unchanged. Once the fingerprint matches, keeping the flag true does not repeatedly rebuild on every restart. A new generation clears the old chunks/checkpoints and scans again; FTS stays available. Indexes from same-name local/cloud implementations are not asserted interchangeable.

Remote endpoints receive the prepared note chunks and queries. Local index encryption does not hide inputs from the inference service. Configure a deliberately trusted provider; do not send real notes during initial public-text transport testing.

## Persisted data and indexing

The store is SQLCipher 4, pinned to compatibility 4, with an authenticated schema read, positive cipher-version check, WAL, in-memory SQL temporary storage, and owner metadata inside the encrypted DB. It rejects wrong/missing keys, ordinary SQLite, a different account and unknown schema. Keys/provider tokens are never put in tables. Schema initialization and each note's replacement are transactional.

`schema/semantic-v1.sql` remains the original relational contract. The runtime initializes its additional revision/observed-fingerprint/parent fields plus `store_owner`, `usage` and `runtime_state` in the same creation transaction. A schema-only test DB is not a production encrypted store and is not auto-adopted. No migration from a previously deployed semantic DB is required because none existed before this phase.

Persisted state includes active generation, indexed source fingerprints, pending/error/deleted note state, little-endian float32 vectors, short excerpts, event cursor, scan checkpoint, provider pause and known usage. The source fingerprint excludes connection secrets and covers title/body with the preprocessing version. The index remains rebuildable, not a second canonical note store.

Initial scope is current readable Markdown title/body. Trashed/deleted, encrypted-but-not-decrypted, locally locked and non-Markdown notes are excluded from the semantic branch. Resources, OCR, note history and tags are not embedded in this first increment. Ordinary keyword search/get_note keep their prior support, including readable HTML.

The chunker splits the entire body at UTF-8 boundaries, with byte-based overlap and a repeated title prefix. Defaults: at most 2,400 bytes per prepared chunk before model prefix, overlap 240 bytes, at most 2,048 chunks per note. Title context uses at most one quarter of the chunk budget. It never silently truncates the body: over-limit notes report an error. Offsets identify UTF-8 body byte positions. This byte bound is **not** a verified token count for an arbitrary model. Configure conservative input/chunk limits and check the provider's tokenizer and long-input/truncation behavior; the common API does not supply a universal truncation-control field.

Enumeration is ID-ordered and metadata-only with the actual Data API; bodies are fetched individually. Each full scan compares source fingerprints. The cursor is captured before an initial scan, and event IDs and cursor changes commit together. Work is coalesced, processed up to 20 notes per cycle, and retried from persisted state. The initial scan starts at page 1. An interrupted or incomplete full scan is retried from page 1 until complete. If the current feed head is behind the saved event cursor, the worker runs a full scan. Routine event processing does not schedule periodic full scans.

`lastReconciledAt` records completion of the latest initial, manual, or reset full scan; routine event processing does not advance it. The persisted scan checkpoint describes full-scan state, not a periodic refresh. Joplin owns the event feed and may prune events older than 90 days after other consumers' cursors permit cleanup, so it is not an indefinite event log.

An embedding result is published only after re-reading the source and checking its fingerprint and pending revision. If the source changed or a newer invalidation arrived, the old result is discarded. This is not an atomic distributed transaction with Joplin; later changes are handled by invalidation and search-time validation.

## Search behavior and limits

`search_notes` still defaults to `keyword`. Choose `mode: semantic` or `mode: hybrid` explicitly. New modes use plain text; use optional `notebookId` for exact single-notebook scope. Raw Joplin filter/negation syntax in these modes is rejected rather than silently ignored. Complex tags/dates/filter expressions still belong to `keyword` Joplin syntax. Do not supply `notebookId` to keyword mode; that combination is rejected, not ignored.

Semantic ranking scans decrypted vectors in bounded batches inside the process, computes exact cosine, and keeps the best chunk per note. Notebook filtering happens before semantic candidate selection. Each candidate is fetched again through its own account's API and checked for eligibility, current fingerprint and notebook scope before returning metadata/excerpts. Stale/deleted/locked results are suppressed and requeued/removed. This ensures no stale excerpt is served from the index as a current result; a source edit racing the final API read is still possible, as with any ordinary read.

Hybrid uses reciprocal-rank fusion (`1/(60+rank)`) over semantic candidates and Joplin keyword candidates, deduplicated by note. It does not add incomparable cosine/BM25 scores. No exact-title boost or reranker is claimed. For hybrid scope, keyword candidates are filtered to the same notebook within their bounded candidate window.

Current semantic/hybrid output is a top-k window, **page 1 only**, at most 100 candidates per branch and 100 returned notes. `hasMore: false` prevents an unsupported page-2 loop; `candidateWindow` and `truncated` describe the result bound. Stale candidates removed during validation can reduce returned count; rerun after indexing catches up. This is not exhaustive filtered search over all matching lexical notes. Use keyword search's normal pagination when that is needed.

The separate MCP tool `semantic_search_notes` returns `results` with chunk rows and `total`, the number of returned matching chunks, rather than one note row per note. It accepts an ordinary nonblank free-text `query`, optional `notebook_id` or `tag_id` (not both), and `relevance` (`strict`, `normal` by default, or `loose`). It does not parse Joplin search filters. A scope is applied before ranked selection; tags restrict note membership but tag text is not embedded. Results contain the source `note_id`, title, notebook ID, chunk index, the full reconstructed matching `chunk_text` including any title context, and its cosine `score` rounded to three decimals. A note may appear more than once when multiple chunks match. Use `read_note` with a result's `note_id` to inspect the full current note.

The presets use these starting floors and result caps for the configured Granite 384-dimensional space:

| Relevance | Cosine floor | Maximum chunks | Relevant pairs returned in the synthetic check | Non-relevant pairs returned |
| --- | ---: | ---: | ---: | ---: |
| `strict` | 0.88 | 5 | 15 of 17 | 0 |
| `normal` | 0.85 | 10 | 17 of 17 | 5 |
| `loose` | 0.80 | 20 | 17 of 17 | 13 |

The 2026-10-24 check used 20 synthetic chunks and 10 English, Chinese and Malay queries, with 17 relevant and 183 non-relevant query/chunk pairs. Result caps did not bind. These floors are model-specific starting settings from a small synthetic sample, not universal thresholds or probability/confidence values; the score is cosine similarity. No personal corpus was indexed for this check.

Status distinguishes unavailable, indexing, ready and degraded, and includes pending/indexed/failed counts, `lastReconciledAt` for the latest initial, manual, or reset full scan, known successful usage and retry time. Index-ready is not proof of global synchronization or perpetual provider availability. Provider failures on an individual query are reflected in that result. Usage reports known successful response tokens, prepared bytes and successful calls; it excludes tokens the provider may charge for failed/ambiguous requests. No corpus cost/free-tier sufficiency has been measured here.

## Tests and real-provider acceptance

The native tests use the real encrypted Joplin core and real SQLCipher storage, but a deterministic HTTP embedding fixture. They validate wiring/consistency/encryption, not live model quality. Existing core/MCP tests remain regressions.

Historical disposable-account validation (2026-09-27) passed on original-source base `2ba0ff820be63ddc98fbaca11dd6671ecefa643b` with Phase 5 fleet accounts `acct-a` and `acct-b`; its mapped public-history commit is `13d7f383b4a74bae8de737ae1ca492c81b178a46`. The results below describe the original source checkout and were not rerun on the mapped commit. The run used OVMS `granite-embedding-311m-multilingual-r2` at fixed 384 dimensions. The public probe returned 384-dimensional vectors for 8 requests, with synthetic top-1 results at 4/4. Indexing reached ready with 36 notes and 0 failures for `acct-a`, and 2 notes and 0 failures for `acct-b`. A known synthetic web note ranked first in semantic and hybrid search for both accounts; keyword ranked each target second, and cross-account targets were absent. Both old BGE derived databases were removed while the fleet was stopped; core profiles and keys were untouched. This tested disposable accounts and synthetic targets before the current dedicated chunk-search integration; it does not establish personal-corpus quality, current native deployment state or endpoint durability.

First use public text only:

```sh
node extras/headless-service/scripts/check-embedding.mjs /private/mcp-semantic.json
```

This calls only the selected endpoint with fixed public English/Chinese/Malay probes, prints shape/known usage and diagnostic synthetic ranks, and exits 0 on valid common-API responses. `PASS embedding-http-shape` does not claim acceptable corpus relevance. No Joplin index/profile is opened.

Then use an approved test corpus and known note IDs, for example:

```json
{"waitMs":120000,"cases":[{"query":"a question or note-search phrase","expectedNoteIds":["32-character-note-id"]}]}
```

```sh
node extras/headless-service/scripts/check-semantic.mjs /private/mcp-semantic.json /private/relevance.json
```

This **starts the indexer and transmits eligible configured-account notes to the chosen endpoint**. Stop any previous semantic owner first. It does not create/update/delete notes or reset E2EE. It waits for ready, executes real semantic searches through the reference MCP client, checks expected notes in the top 10, prints ranks/timings without note text/IDs, and closes the MCP owner. Save the output and exit code. The deadline is configurable up to one hour; for larger backlogs, let the MCP indexer complete first.

Alternatively `node extras/headless-service/semantic-index.mjs /private/mcp-semantic.json` executes one bounded indexing cycle without stdio hosting. Exit 0 means ready, 2 means more indexing/degraded work, 1 is setup/runtime failure, and 130 means interrupted. The offline engine API also supports `runOnce({ rescan: true })` for an exceptional full repair. Do not run either operation alongside an MCP semantic owner using the same database.

Phase 2A's already-passed read-only protocol check need not be repeated wholesale. The targeted two-account run exercised real semantic/hybrid search and indexing, but did not measure retrieval on production notes, long-input behavior, sustained latency/lag or endpoint durability.

## Primary interface references

Checked 2026-09-27. Implementation uses the pinned supplied native package; it does not switch to a newly advertised release.

- SQLCipher keying/version/compatibility: https://www.zetetic.net/sqlcipher/sqlcipher-api/
- OVMS embedding deployment: https://github.com/openvinotoolkit/model_server/blob/main/demos/embeddings/README.md
- Ollama common embedding endpoint: https://docs.ollama.com/api/openai-compatibility
- Cloudflare common API: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
These references establish interfaces, not results from a model run here.
