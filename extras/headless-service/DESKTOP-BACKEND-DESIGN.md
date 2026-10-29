# Stock Desktop backend design for the external MCP adapter

## Target, scope, and status

Design date: 2026-10-28. The target is **unmodified stock Joplin Desktop**. The external adapter in `extras/headless-service` would connect to Desktop's existing Web Clipper/Data API and built-in `/mcp` endpoint.

This document authorizes no implementation. The existing headless implementation, configuration, deployment, and native runtime remain unchanged. No custom Desktop build, native action registration, plugin, or direct database connection is part of this design.

The aim is to retain useful features of our richer external MCP interface where stock Desktop can supply their behavior. Equivalent results do not establish equivalent consistency, latency, or operating cost. No comparative performance has been measured.

Some current public contracts depend on native guarantees that stock endpoints cannot provide. Those differences require user decisions before mutation implementation; this document does not silently weaken them or choose to disable all editing.

## Sources and established facts

The following official documentation was retrieved on 2026-10-28. It establishes the current stock integration surface. The user's installed version and runtime have not been inspected.

- [Data API reference](https://joplinapp.org/help/api/references/rest_api/): notes, notebooks, tags, resources, search, revisions, pagination, selected fields, deleted/conflict inclusion, resource references, and the events feed. Page size is limited to 100. The documented API has no conditional revision-aware note `PUT` or transaction spanning several requests.
- [Desktop MCP guide](https://joplinapp.org/help/apps/ai_mcp/): Desktop already serves `/mcp` on the Clipper port using its API token, with MCP enablement and individual tool controls. Available tools include notebook listing, tag management, and ordinary note editing.
- [Desktop MCP technical specification](https://joplinapp.org/fr/help/dev/spec/ai_mcp/): initialization, tool discovery and calls, notifications, JSON encoded in text results, and tool errors distinct from JSON-RPC errors. Its `list_notebooks` result includes `note_count`.
- [Semantic search guide](https://joplinapp.org/help/apps/ai_semantic_search/): stock Desktop 3.7 and later can expose `semantic_search_notes` through MCP using Desktop's existing semantic index. The UI's combined semantic/keyword behavior does not establish hybrid behavior for REST `/search`.
- [Note history specification](https://joplinapp.org/help/dev/spec/history/): revisions preserve note states at intervals; the service processes changed-item records, can save the pre-edit state for an old note, and does not create a revision for every edit.

The pinned upstream `v3.7.21` source confirms the ordinary REST history path. A [REST note `PUT`](https://github.com/laurent22/joplin/blob/v3.7.21/packages/lib/services/rest/routes/notes.ts#L543-L572) calls [`Note.save`](https://github.com/laurent22/joplin/blob/v3.7.21/packages/lib/models/Note.ts#L912-L970), which queues an `ItemChange` after saving. [`RevisionService`](https://github.com/laurent22/joplin/blob/v3.7.21/packages/lib/services/RevisionService.ts#L78-L109) skips revision creation when less than the configured interval has elapsed since the previous revision. Its [background schedule](https://github.com/laurent22/joplin/blob/v3.7.21/packages/lib/services/RevisionService.ts#L335-L349) starts maintenance four seconds after the service starts and defaults to a ten-minute interval; the [settings](https://github.com/laurent22/joplin/blob/v3.7.21/packages/lib/models/settings/builtInMetadata.ts#L2171-L2172) set a ten-minute revision interval and a seven-day old-note interval. The [collector](https://github.com/laurent22/joplin/blob/v3.7.21/packages/lib/services/RevisionService.ts#L116-L237) advances its change cursor while processing updates even when interval throttling skips a revision, so waiting alone does not guarantee a final snapshot. These source links are pinned to upstream `v3.7.21`; they do not establish the user's installed version or runtime behavior.

Tool discovery, rather than a fixed tool count or assumed toggle defaults, determines which built-in MCP tools the adapter can call. A disabled or missing built-in tool is unavailable on that path; do not silently substitute a REST implementation with different behavior or cost. Data API access is separate and does not inherit MCP tool switches automatically.

The local fork explains the existing headless contract. It is not proof that unmodified upstream Desktop has the fork's services or matching behavior. Relevant headless code includes `HeadlessNoteService`, `HeadlessRevisionHistory`, `HeadlessAttachmentReferences`, and app-cli's headless maintenance operations.

## Proposed architecture and ownership

Add a small Desktop backend inside the adapter's existing operation registry. Keep the headless backend and its routes unchanged. An explicit backend selection should choose the intended backend; no automatic fallback or discovery is proposed.

The Desktop backend would contain an authenticated REST client and a small stock MCP client. The MCP client must initialize the connection, discover tools, call supported tools, and map result and error envelopes into the adapter's existing interface.

Use REST where its documented contract fits the operation. Reuse built-in MCP operations when they supply native behavior needed by the adapter, especially notebook counts, tag management, and semantic search. A transport preference must not replace a behavior check.

The adapter owns external MCP schemas, file handling, patch computation, backend selection, and explicit result/error mapping. Stock Desktop owns its data, indexing, native save behavior, history scheduling, and existing tools. The GUI remains responsible for application status; ordinary connection and operation failures continue through the adapter's existing error handling, and this design adds no replacement status tool, native code, or database access.

The Clipper token remains the credential. Its Data API access is broader than the individual MCP tool switches; those switches are not token scopes. Retain the adapter's existing `allowWrites` setting. Describe which operations use REST and which require an enabled built-in tool, rather than claiming that MCP switches govern REST access or inventing a new permission policy.

Connecting to the intended local Desktop endpoint and confirming its reachability is a setup task for later validation. Exposing a raw API remotely or redesigning network security is outside this document's scope.

## Capability paths, guarantees, and costs

| External capability | Stock path | Contract difference or cost |
| --- | --- | --- |
| Note listing and ordinary reads | REST notes and selected fields | Feasible with pagination. A fetched note snapshot does not receive a matching native revision merely by fetching the latest history row separately. |
| Note creation and ordinary field writes | REST note creation/update, or an enabled built-in tool where its behavior fits | Standard title, body, to-do, and source URL fields are available. Ordinary save feasibility does not settle our guarded-update contract. |
| Keyword search | REST `/search` | Preserve supported query and result mapping. Do not label it semantic or hybrid search. |
| Semantic search | Enabled built-in `semantic_search_notes` | Reuse Desktop's index and map its inputs, output, and errors explicitly. Do not install headless OVMS/semantic storage or silently substitute keyword search. Existing adapter search modes need an explicit mapping. |
| Notebook listing and counts | Enabled built-in `list_notebooks` | Reuse the returned native `note_count`. Do not enumerate all note metadata to count notebooks. One HTTP call establishes neither a grouped SQL implementation nor equal CPU cost or latency. |
| Tags | Enabled built-in `manage_tags` where its operation fits | Reuse stock tag-management behavior instead of assuming that REST tag search and client-side matching reproduce the headless title lookup. The precise stock matching rules still need verification. |
| Notebook creation and ordinary metadata | REST folders or applicable enabled built-in tool | Feasible when the selected operation preserves the required behavior. Notebook moves require separate checks below. |
| Conflicts and Trash inspection | REST include flags and relevant note/folder fields | Feasible to compose and paginate. Preserve conflict identity and original-parent information; do not infer restore guarantees from inspection support. |
| Trash restoration | Applicable enabled stock tool, otherwise REST composition after rules are verified | Exact descendant handling and missing-parent fallback remain unverified. Several saves can partially succeed; do not promise a single atomic restore or hide partial failures with retries. |
| Attachment bytes and metadata | REST resources and multipart transfer | Feasible. Verify filenames, metadata, and adapter output against the current attachment contract. Note-body files are a separate workflow. |
| Notes referencing an attachment | REST `/resources/:id/notes` for resource associations | The endpoint is documented, but current saved-body equivalence, inclusion of Trash/conflicts, and indexing delay must be checked against the target stock version. The headless tool scans readable saved bodies. Reproducing that scan externally requires paged note bodies and can be expensive; the existing tool name must not silently acquire weaker semantics. |
| Revision listing, reconstruction, and comparison | REST revisions plus adapter computation | Ordinary history listing, reading, reconstruction, and comparison remain available. No note/item revision filter is documented, so listing may require paging all revision metadata and filtering it locally. Native history is asynchronous, interval-throttled, and may coalesce several edits; it does not record every edit or guarantee a revision for the current note snapshot. |
| Revision-aware reads and guarded updates | No equivalent documented stock transaction | Separate reads, history calls, and saves cannot reproduce the headless snapshot/capture/check/save transaction. The latest revision ID may lag the note's current content, and a precheck followed by a save still has a race. The public mutation contract needs a decision before implementation. |
| `grep_notes` | Fetch scoped current note bodies through REST and reuse pure matching/line logic | Note/notebook selectors can bound the work, but body transfer and pagination add cost. An exact native revision for the searched snapshot may not exist; current revision metadata and edit guards do not transfer automatically. |

## Note snapshots, patches, and file workflows

The headless `readNote` captures a native revision for the exact note snapshot it returns. Its `updateNote` checks both current native history and note content, then atomically saves the edit and before/after revisions using the expected-item transaction. Inline reads, file reads, metadata reads, and grep results participate in that revision contract.

Stock REST cannot supply the same capture-and-save transaction. A latest revision fetched after a note read may describe another snapshot, and scheduled history can leave the latest row behind the note's current content. Ordinary history list/read/reconstruction/comparison still works, but the history service is asynchronous and interval-throttled, can coalesce multiple saves, and does not capture every edit. Therefore, a history row cannot be treated as an exact revision ID for every note read.

An ordinary REST note `PUT` calls `Note.save`, which queues an `ItemChange` for the background revision service. The collector starts maintenance four seconds after that service starts and then runs every ten minutes by default. Revision creation is skipped when less than ten minutes have elapsed since the previous revision's `updated_time`; the collector still advances its change cursor for a processed update that was skipped. Passage of time alone therefore does not guarantee a later snapshot of the final content. The seven-day old-note path can save a pre-edit state for an old note, as described in the official history specification; it does not turn history into an every-edit log.

`body_patch` and exact-text matching can run in the adapter. Compute the entire proposed update before sending a save so an invalid patch sends no `PUT`, including accompanying metadata. This preserves local patch validation, but it does not prevent another Desktop or sync write between the read and save.

An adapter mutex would serialize only its own calls. It cannot block Desktop editing or sync. A precheck followed by an ordinary save therefore cannot be presented as compare-and-swap, even if a representative stale edit is detected.

Do not invent a revision token, use a dummy revision, convert the latest history row into a snapshot ID, or silently make `base_revision_id` optional across both backends. Do not synthesize raw revision rows by default: `POST /revisions` does not create a shared lock or transaction with a note save.

The useful file workflow can remain adapter-owned: export/download the note body as UTF-8, inspect its byte count and hash, and submit a file without placing its whole body in model context. File mode reduces model-context use; it does not remove body transfer between Desktop and the adapter. Note-body files are not attachment resources. Their revision metadata and save behavior must follow the chosen Desktop contract.

`grep_notes` can reuse matching and line-number computation over scoped fetched bodies. Its output must represent the snapshot it actually searched under the agreed Desktop schema. It cannot promise that a returned native revision will guard a subsequent update unless that relationship is established.

Keep current error semantics. Do not automatically retry an edit against a newer snapshot or treat an unknown save outcome as success. Multi-request operations must expose partial failures where they occur.

## Native behavior requiring explicit verification

Notebook moves currently use native `Folder.canNestUnder` and `moveToFolder` in the headless path. These check ancestor cycles and propagate sharing state. Reading the notebook graph can reproduce some validation, but a generic REST folder `PUT` does not by itself establish equivalent race handling or sharing behavior.

Verify the installed stock tools and upstream rules before mapping notebook moves or exact Trash restoration. Local observations of tag CSV writes and `deleted_time` restoration are provisional until checked against tagged upstream source or the target runtime. The design does not impose a new blanket prohibition; it records where ordinary CRUD alone is insufficient to establish the existing contract.

For attachment references, first establish the stock association endpoint's actual scope and freshness. If it differs, choose whether the public operation retains current saved-body semantics or exposes the indexed semantics explicitly. Do not run an automatic full-note-body scan for ordinary calls, or add scan caches and reconciliation infrastructure as a shortcut.

## Public contracts to settle before mutation implementation

The principal user decision is whether Desktop edits may use a weaker contract: an adapter precheck followed by an ordinary stock save, with normal native history and a documented concurrent-write gap. The alternative is to leave operations requiring the existing atomic snapshot/revision guarantee unavailable while retaining operations that stock endpoints can satisfy.

That decision must also settle how Desktop reads, grep, file reads, and edits express snapshot/revision information. A Desktop-specific schema may be appropriate, but no replacement token or schema has been selected. The headless contract remains intact.

Related mappings need bounded decisions once their stock behavior is verified: attachment references with saved-body versus indexed scope and search modes that stock MCP actually supports. Exact notebook-move and restore behavior must be established before promising parity.

These are public behavior decisions owned by the user. They are not permission requests for implementation in this document, and no mutation policy is selected by writing the design.

## Ordered implementation outline, when authorized

These are dependency-ordered work items, not additional approval gates for every step.

1. Confirm the intended stock Desktop version, local Clipper endpoint, token, MCP enablement, and discovered tools. Record actual capability availability without assuming toggle defaults.
2. Settle the affected public contracts above before implementing dependent mutations. Establish explicit backend selection within the existing adapter configuration; preserve headless behavior.
3. Add the thin REST and stock MCP clients and operation mappings. Start with operations whose contracts are supported, including ordinary reads, notebook counts, tag behavior, and available search modes.
4. Add file and resource transfer mappings, history reconstruction/comparison, and verified composed operations. Implement edits only under the agreed Desktop contract, preserving failures and partial outcomes.
5. Validate representative operations against actual stock Desktop, then run the relevant existing headless checks. Document remaining capability differences without claiming unmeasured parity.

No framework migration, native registration, plugin, direct database query, automatic global scan, or new fallback system is required by this outline.

## Focused runtime validation, when authorized

Use the user's intended stock version and a disposable test note. No Desktop runtime action or test-note creation has been performed for this design.

- Confirm initialization, tool discovery, disabled/missing tool handling, result/error mapping, and standalone Desktop operation with no headless-service calls.
- Check note-body file bytes, UTF-8 handling, size/hash acknowledgments, and a representative multipart attachment transfer without returning large bodies inline.
- Verify that an invalid patch sends no save and leaves accompanying metadata untouched. Exercise the agreed stale-edit checks while recording the remaining read/write race; a passing stale test cannot prove zero lost writes.
- Check revision reconstruction, history scope, ordering, pagination, and comparison against actual native history. Do not mistake scheduled history for an every-edit log.
- Confirm notebook counts come from the enabled native tool without global note enumeration. Check tag lookup and semantic search behavior under the installed tool settings.
- Exercise verified notebook/Trash behavior and attachment-reference scope, including visible partial failures where applicable. Run relevant existing headless regression checks after adapter changes.

Use focused integration checks rather than synthetic mocks as proof of stock behavior. No benchmark or performance equivalence claim is part of this plan.

## Current state and review

The design now targets unmodified stock Desktop through existing endpoints. The current headless service remains unchanged. Implementation is not authorized; the mutation contract and other identified public mappings remain unresolved.

Fresh independent rubber-duck review (Sol, high reasoning effort, 2026-10-28) found no blocking design defects or other substantive findings. It assessed stock-only requirement alignment separately from design correctness and independently checked the official Data API, MCP, and semantic-search documentation linked above. The reviewer confirmed that the open mutation/schema choices are implementation dependencies, not settled behavior or hidden prohibitions.

The review did not inspect an installed stock runtime, verify tagged upstream implementations of notebook/tag/restore/resource rules, or measure performance. A subsequent source check verified the v3.7.21 revision path and history scheduling described above; it did not repeat the independent design review. The user's installed version remains unchecked. These limits remain explicit in the plan. This is a reviewed design with unresolved public-contract decisions, not a claim of implemented or verified Desktop parity.
