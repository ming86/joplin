# Semantic search — Phase 2B

The Phase 2A read-only selected-host check passed on Codex CLI 0.155.1 with directly observed exit 0. Its exact supplied report is under `evidence/2026-09-20-codex/`. No fixes were needed. That does not claim write-mode host testing or full MCP conformance.

This increment adds a separate encrypted derived index, an OpenAI-compatible HTTP embedding transport, incremental indexing and semantic/hybrid search. Joplin's core, dependency lockfile, original FTS and E2EE are unchanged. It introduces no disk/volume encryption, blanket attachment policy, cloud ingress, LLM chat, reranker or vector server.

## Operational setup

Start with the existing encrypted core and its private API. Copy `scripts/semantic.example.json` to a private absolute path and set the account, endpoint, existing API token file, semantic database location, SQLCipher binding and embedding deployment. The example's `bge-m3` is an operator-selected local endpoint model alias, not a downloaded model, measured winner or guarantee that a server is running. Its model revision placeholder must be replaced with the deployed revision or a deliberately versioned operator configuration when exact weights are unavailable.

Generate **a separate 32-byte random semantic DB key** as 64 hexadecimal characters plus an optional newline, and deliver it as an owner-only file (`0600`) through your existing secret-delivery mechanism. Keep this key/recovery copy separate from index backups; file permissions alone do not protect a copied key beside its DB. Do not reuse, regenerate or reset the existing Joplin E2EE identity or core database key. The MCP process needs its semantic DB key and the core API token, not the core's database or E2EE key.

Set the archive's `LD_LIBRARY_PATH` as described in its `README-run.txt`. Use `semantic.sqliteModule`, or the existing `JOPLIN_HEADLESS_SQLITE_MODULE`, to identify the complete compatible SQLCipher-enabled sqlite3 Node package. There is no plaintext/native-binding fallback and no `yarn install` step.

For remote inference set the desired common-API `baseUrl`, `model`, `remoteProcessing: true`, and (where needed) an `apiKeyFile` inside `semantic.embedding`. Token files are owner-only. Only explicit trusted startup configuration chooses destinations; MCP arguments cannot supply backend URLs, keys or account identities. A non-loopback endpoint requires explicit remote consent; an insecure private HTTP address additionally requires `allowInsecureHttp: true`. A loopback proxy can itself forward remotely: these declarations are operator policy, not proof of where inference happens.

Run as before:

```sh
node /absolute/repo/extras/headless-service/mcp.mjs /private/mcp-semantic.json
```

The process asynchronously polls and indexes while serving MCP. It is **one semantic DB owner per account**: do not launch several such MCP processes against the same DB. Additional read-only MCP configurations without semantic enabled can still use core keyword search. The intended later gateway can share one engine; this increment does not add another network service or pretend it already hosts arbitrary simultaneous MCP clients.

On orderly shutdown the indexer is cancelled and its DB/lease closed. After an unclean kill a `semantic.sqlite.lock/owner.json` directory may remain. Confirm that no process owns that DB before manually removing this directory; there is no unsafe automatic takeover of a possibly live owner. Never remove the actual DB to recover just a stale lease.

A missing/wrong key, foreign-account DB, unsupported native binding or incompatible configuration reports semantic unavailable while leaving the private core and keyword interface usable. It does not overwrite the protected index or silently create a plaintext replacement. Ordinary MCP configuration without `semantic` retains Phase 2A behavior.

## Provider and model contract

The common request is `POST <baseUrl>/embeddings` with `model`, string-array `input` and `encoding_format: float`. Batches are bounded. Results are reassembled by index and checked for count, dimensions, finite/nonzero vectors and usage shape. Model-specific query/document prefixes are applied exactly once. L2 normalization is the default. No API SDK, tokenizer, model weights or ONNX runtime is added to the fork.

Transport has timeouts, cancellation, bounded responses and redirect refusal. It makes one attempt per request. The indexer persists pending work and retry deadlines; provider rate-limit/outage failures pause further document work with bounded backoff and respect bounded `Retry-After`. Hybrid requests fall back to keyword search with explicit status. No query vector from an unrelated model is substituted.

Endpoint hosting/credentials are operational configuration. Index identity includes the embedding space fingerprint, operator revision, dimensions, preparation/normalization, chunker settings and requested model alias. Changing one of these incompatibly requires explicit `semantic.rebuild: true`. That acknowledges replacement of this **derived index only**; Joplin notes and core DB are not touched. Once the fingerprint matches, keeping this flag true does not repeatedly rebuild on every restart. A new generation clears the old chunks/checkpoints and scans again; FTS stays available. Indexes from same-name local/cloud implementations are not asserted interchangeable.

Remote endpoints receive the prepared note chunks and queries. Local index encryption does not hide inputs from the inference service. Configure a deliberately trusted provider; do not send real notes during initial public-text transport testing.

## Persisted data and indexing

The store is SQLCipher 4, pinned to compatibility 4, with an authenticated schema read, positive cipher-version check, WAL, in-memory SQL temporary storage, and owner metadata inside the encrypted DB. It rejects wrong/missing keys, ordinary SQLite, a different account and unknown schema. Keys/provider tokens are never put in tables. Schema initialization and each note's replacement are transactional.

`schema/semantic-v1.sql` remains the original relational contract. The runtime initializes its additional revision/observed-fingerprint/parent fields plus `store_owner`, `usage` and `runtime_state` in the same creation transaction. A schema-only test DB is not a production encrypted store and is not auto-adopted. No migration from a previously deployed semantic DB is required because none existed before this phase.

Persisted state includes active generation, indexed source fingerprints, pending/error/deleted note state, little-endian float32 vectors, short excerpts, event cursor, scan checkpoint, provider pause and known usage. The source fingerprint excludes connection secrets and covers title/body with the preprocessing version. The index remains rebuildable, not a second canonical note store.

Initial scope is current readable Markdown title/body. Trashed/deleted, encrypted-but-not-decrypted, locally locked and non-Markdown notes are excluded from the semantic branch. Resources, OCR, note history and tags are not embedded in this first increment. Ordinary keyword search/get_note keep their prior support, including readable HTML.

The chunker splits the entire body at UTF-8 boundaries, with byte-based overlap and a repeated title prefix. Defaults: at most 2,400 bytes per prepared chunk before model prefix, overlap 240 bytes, at most 2,048 chunks per note. Title context uses at most one quarter of the chunk budget. It never silently truncates the body: over-limit notes report an error. Offsets identify UTF-8 body byte positions. This byte bound is **not** a verified token count for an arbitrary model. Configure conservative input/chunk limits and check the provider's tokenizer and long-input/truncation behavior; the common API does not supply a universal truncation-control field.

Enumeration is ID-ordered and metadata-only with the actual Data API; bodies are fetched individually. Each rescan compares source fingerprints. The cursor is captured before an initial scan; event IDs and cursor changes commit together. Work is coalesced, processed up to 20 notes per cycle, and retried from persisted state. Periodic reconciliation and result validation cover missed/coalesced events and bounded event retention. A failed/incomplete scan is not a successful empty collection. Offset pages missed during concurrent changes are not used as sole deletion evidence; stored IDs are rechecked individually. A source cursor moving backward triggers reconciliation. A resumed interrupted scan starts at page 1 safely; completed embeddings are reused by fingerprint.

An embedding result is published only after re-reading the source and checking its fingerprint and pending revision. If the source changed or a newer invalidation arrived, the old result is discarded. This is not an atomic distributed transaction with Joplin; later changes are handled by invalidation and search-time validation.

## Search behavior and limits

`search_notes` still defaults to `keyword`. Choose `mode: semantic` or `mode: hybrid` explicitly. New modes use plain text; use optional `notebookId` for exact single-notebook scope. Raw Joplin filter/negation syntax in these modes is rejected rather than silently ignored. Complex tags/dates/filter expressions still belong to `keyword` Joplin syntax. Do not supply `notebookId` to keyword mode; that combination is rejected, not ignored.

Semantic ranking scans decrypted vectors in bounded batches inside the process, computes exact cosine, and keeps the best chunk per note. Notebook filtering happens before semantic candidate selection. Each candidate is fetched again through its own account's API and checked for eligibility, current fingerprint and notebook scope before returning metadata/excerpts. Stale/deleted/locked results are suppressed and requeued/removed. This ensures no stale excerpt is served from the index as a current result; a source edit racing the final API read is still possible, as with any ordinary read.

Hybrid uses reciprocal-rank fusion (`1/(60+rank)`) over semantic candidates and Joplin keyword candidates, deduplicated by note. It does not add incomparable cosine/BM25 scores. No exact-title boost or reranker is claimed. For hybrid scope, keyword candidates are filtered to the same notebook within their bounded candidate window.

Current semantic/hybrid output is a top-k window, **page 1 only**, at most 100 candidates per branch and 100 returned notes. `hasMore: false` prevents an unsupported page-2 loop; `candidateWindow` and `truncated` describe the result bound. Stale candidates removed during validation can reduce returned count; rerun after indexing catches up. This is not exhaustive filtered search over all matching lexical notes. Use keyword search's normal pagination when that is needed.

Status distinguishes unavailable, indexing, ready and degraded, and includes pending/indexed/failed counts, last reconciliation, known successful usage and retry time. Index-ready is not proof of global synchronization or perpetual provider availability. Provider failures on an individual query are reflected in that result. Usage reports known successful response tokens, prepared bytes and successful calls; it excludes tokens the provider may charge for failed/ambiguous requests. No corpus cost/free-tier sufficiency has been measured here.

## Tests and real-provider acceptance

The native tests use the real encrypted Joplin core and real SQLCipher storage, but a deterministic HTTP embedding fixture. They validate wiring/consistency/encryption, **not BGE-M3 quality or any live vendor deployment**. Existing core/MCP tests remain regressions.

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

Alternatively `node extras/headless-service/semantic-index.mjs /private/mcp-semantic.json` executes one bounded indexing cycle without stdio hosting. Exit 0 means ready, 2 means more indexing/degraded work, 1 is setup/runtime failure, and 130 means interrupted. Repeat only as the persisted retry timing permits, or use the normal MCP background owner. It shares the same exclusive store ownership.

Finally exercise semantic/hybrid search in the chosen real MCP host. Phase 2A's already-passed read-only protocol check need not be repeated wholesale. The remaining acceptance is a live embedding deployment, representative notes/languages/long input, measured token/latency/lag, and operational semantic retrieval—not another native dependency pack. No live provider credentials or model weights were supplied for this implementation session.

## Primary interface references

Checked 2026-09-20. Implementation uses the pinned supplied native package; it does not switch to a newly advertised release.

- SQLCipher keying/version/compatibility: https://www.zetetic.net/sqlcipher/sqlcipher-api/
- Ollama common embedding endpoint: https://docs.ollama.com/api/openai-compatibility
- Cloudflare common API: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- BGE-M3 publisher's model card (dense candidate and query preparation): https://huggingface.co/BAAI/bge-m3

These references establish interfaces/model documentation, not results from a model run here.
