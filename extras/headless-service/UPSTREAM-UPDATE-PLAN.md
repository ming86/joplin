# Update the headless service from `dev`

## Decision

Merge the updated `dev` branch into `feat/headless-service`, then reconcile the upstream changes with the headless service's existing native revision, sync, and MCP behavior.

The branches have diverged, so this will produce a merge commit. Preserve both histories. Do not replace complete files or cherry-pick a dependency-only subset. The listed upstream commits explain behavior included by the full merge; they are not a cherry-pick queue.

If `dev` advances before the merge, record the actual target revision and summarize material changes from the captured target below before resolving conflicts. Do not silently broaden the approved target.

## Upstream behavior to retain

The merge includes upstream fixes and behavior that affect the headless build:

- Preserve the HTTP 422 correction ([`330b86e63`](https://github.com/laurent22/joplin/commit/330b86e63)), conflict-merge blank-line behavior ([`2a901dea1`](https://github.com/laurent22/joplin/commit/2a901dea1)) and conflict merge timestamps ([`c199af7ca`](https://github.com/laurent22/joplin/commit/c199af7ca)).
- Preserve cross-device sync of eligible conflict copies ([`552671dde`](https://github.com/laurent22/joplin/commit/552671dde), [`7fdcf1eab`](https://github.com/laurent22/joplin/commit/7fdcf1eab), [`f5b2d654d`](https://github.com/laurent22/joplin/commit/f5b2d654d)). Eligibility requires a nonempty `conflict_original_id` and empty `share_id`; unlinked conflicts stay local. This changes which conflicts MCP tools can see after another client syncs.
- Preserve upstream note-lock history and key/migration handling ([`2bddab0d0`](https://github.com/laurent22/joplin/commit/2bddab0d0), [`4571f6938`](https://github.com/laurent22/joplin/commit/4571f6938), [`75f888ff0`](https://github.com/laurent22/joplin/commit/75f888ff0)) when reconciling `RevisionService` with the headless revision helpers. Keep the MCP's existing locked-note restrictions.
- Include the small HTML conversion fixes ([`94168d33d`](https://github.com/laurent22/joplin/commit/94168d33d), [`94ddfda2d`](https://github.com/laurent22/joplin/commit/94ddfda2d)) through the full merge; they are not the primary Markdown path.
- Include the revision-service startup fix ([`e972fd239`](https://github.com/laurent22/joplin/commit/e972fd239)). It fixes Desktop/Mobile startup after a failed initial sync; headless already starts revision collection before initial sync.

Review the local `dev` commits for source context. Do not make dependency vulnerability claims based on this update.

## Merge and conflict work

1. Confirm the worktree is clean and record the current branch, both branch tips and merge base. Compare `dev` with the captured `b48e75856d81152c32e71f21075e1c043d9ea922`; summarize any material new changes before proceeding.
2. Merge the agreed `dev` target into `feat/headless-service`. Keep the merge history and review the 15 paths changed by both sides, including changes that Git merges automatically. Shared changed paths are not necessarily textual conflicts.
3. Reconcile `packages/lib/services/RevisionService.ts` with `HeadlessNoteService` and the native revision helpers. Keep upstream lock history and migration/key handling while preserving headless exact-snapshot capture, conditional save, and history reconstruction.
4. Resolve conflicts by inspecting each side's behavior and its callers. Do not replace a file wholesale or drop a change just because it is outside the headless package; the full upstream baseline is part of the approved scope.
5. Do not add behavior beyond this scope during conflict resolution. If an unresolved conflict requires a new product or compatibility decision, stop and consult the user before implementation.

## Networking and dependency adaptation

Upstream moves networking to Undici ([`24e577825`](https://github.com/laurent22/joplin/commit/24e577825)) and configures direct connections to one. Adapt headless sync to its existing `sync.maxConcurrentConnections` value of 10.

Preserve the configured value at runtime. Dynamic setting changes and direct-versus-proxy behavior must follow the actual configuration; do not force 10 globally or bypass the proxy setting.

Adapt the headless connection-limit tests and implementation, which currently use HTTP agents, `maxSockets` and `node-fetch`, to the new client. Carry the complete migration through streaming, timeouts, error causes, custom CAs and `BaseApplication`; changing only the package declaration is incomplete.

The resulting Node floor is 22.19, which the current `extras/headless-service/deploy/Containerfile` base image 26.11.1 satisfies. Avoid unrelated runtime dependency upgrades.

## Preserve headless data and sync guarantees

Keep the custom atomic save path: `expectedItem` and `nextQueries` passed to `Note.save()`, native before/after revision capture, and stale-base rejection. Commit an edit's revision rows together with its successful conditional note save; a rejected save must not leave partial edit history. Existing reads may still capture native revisions for the snapshots they return. Do not add dummy versions or weaken guards to fit upstream behavior.

Keep the coordination among `HeadlessNoteService`, `RevisionService` capture, note locks, revision reconstruction, and upstream lock-history encryption. Apply `markChangedSinceCollection` only after persistence succeeds.

Keep SQLCipher profiles, resource permissions, and private core routes. Do not alter these boundaries as a side effect of resolving sync or revision conflicts.

Preserve scheduler timing and sequencing: wait 20 seconds after a remote check finishes; pause during full sync and start a fresh delay after it resumes; wait 120 seconds after a periodic request settles, including failure; debounce local edits by about one second and run follow-ups without overlapping requests. A successful local write must upload even when the remote-change optimization reports no remote changes.

Keep the persisted semantic change feed and the existing OVMS engine, index, and chunker. Do not change chunking, reindex the corpus, or add a recurring full-content scan.

## MCP additions and revision-safe reads

The approved headless additions are outline retrieval, section reading through `read_note`, and enclosing-section metadata in `search_notes`. The full upstream merge retains stock `read_notes` source, but wiring that tool into the sidecar is deferred to a later scope.

| Read mode | Request and result | Coordinate and compatibility rules |
| --- | --- | --- |
| Existing read | Keep current `read_note` and `get_note` behavior, including full-body default, line/character reads, metadata, and file output. | Preserve current aliases, numeric legacy fields, source metadata, file descriptors and MIME types, newline handling, and exact native revision capture. |
| Outline | `outline: true` returns an `outline` array with `path`, `heading`, `level`, `start_offset`, `end_offset`, `start_line`, and `end_line` for each heading. | Offsets are whole-source UTF-16 positions in a half-open range; lines are whole-source, inclusive, 1-based. When headings exist, a nonempty preamble before the first heading uses path `0`; notes with no headings return an empty array. Return no body text or body paging fields. Use a separate output-schema branch with complete-note metadata. Reject character and line selectors. |
| Section | `section` accepts a positional path or a unique exact heading after the upstream parser's heading normalization. A duplicate heading requires its positional path; invalid and ambiguous selectors return explicit errors rather than a full-note fallback. Return the selected source text and distinct fields `section_path`, `section_heading`, `section_start_offset`, and `section_end_offset`. | A section starts at its heading and ends before the next heading of equal or higher level, including subsections. When headings exist, path `0` selects a nonempty preamble. Section offsets identify its whole-source UTF-16 range. `offset`, `max_chars`, and legacy positive `length` page in whole-source coordinates; omitted `offset` starts at the section start and bounds clamp to the section. Omitted or zero `max_chars` returns the rest of that section unless a positive legacy `length` is supplied while `max_chars` is omitted. Keep surrogate pairs intact. `body_offset` and legacy `offset` report the actual absolute source start after surrogate-safe adjustment; `body_returned_chars` reports the actual returned UTF-16 units; `nextOffset` is the absolute source position after the returned text or `null` at the section end. `has_more` means more remains in the selected section. Reject `start_line` and `end_line` with `section`; line mode remains unchanged when used alone. |
| File or metadata | Metadata output describes the complete note without returning its body. File output returns the complete body. | These modes reject `outline`, `section`, and body selectors (`offset`, `max_chars`, `length`, `start_line`, `end_line`). File output exports the complete body so it remains safe to reimport as a full rewrite. Navigation is inline-only. |

`outline: true` and `section` are mutually exclusive. Keep the current full-body default; do not copy upstream's 8,000-character default or add arbitrary output caps. For outline and section reads, `body_length`, `totalLength`, `body_total_line_count`, and any existing `body_size_bytes` or `body_sha256` fields continue to describe the complete source note. Do not repurpose them as selected-content measurements or require a new full-body hash for inline reads. Section `body` contains only the selected slice; its metadata must not imply that the partial text is a complete replacement. Keep the existing output shape for ordinary reads, with only the approved outline and section result fields added to their respective modes.

Outline and section calls read independent current snapshots; they are not a pinned multi-call transaction. Return the native source `revision_id` with each result. If the section read's revision differs from the outline's, refresh the outline before relying on a positional path because headings may have moved. Do not add read-time expected-revision parameters or locks. Use the existing `base_revision_id` guard for edits after a read, and preserve exact source-snapshot capture rather than substituting the latest history row.

Use the upstream Markdown outline parser where it fits, including its normalized full-heading lookup; do not add partial or fuzzy heading matches. Keep HTML reads unchanged and do not parse HTML as Markdown. Preserve `accountEmail` without adding account-binding IDs. Add section metadata to search results only when the actual source keyword match can be located; do not infer a section from a summary or change grep behavior. Keep updates revision-protected and do not add numeric `line_edits`.

Update tool descriptions, input/output schemas, schema declarations, and `extras/headless-service/MCP.md` for the three additions and their search → outline → section → protected-update workflow.

## Focused validation

Run the repository's existing focused checks for the behavior changed by the merge and adapters:

- Core HTTP 422 handling, conflict merge output and timestamps, sync conflict eligibility, note-lock history, and revision/key/migration handling.
- Headless native revision capture and stale compare-and-save, scheduler sequencing, configured connection limits, SQLCipher, and the sidecar catalog/schema files.
- MCP selector combinations and output-schema branches; repeated headings, invalid/ambiguous section errors, empty outlines, Unicode/newlines, source metadata versus section metadata, absolute-source offsets, surrogate-safe continuation and section-end behavior.
- Actual MCP-to-native integration using synthetic notes for search section metadata, outline and section reads, exact per-read source revisions, a `base_revision_id` guarded update and stale rejection, revision history, and the complete file export/reimport workflow. Clean up test notes through normal Trash behavior.

Run TypeScript compilation with JavaScript emission before the CLI build copies generated files into its bundle. Check the public declarations as well. Avoid exhaustive GUI benchmarks, a new test framework, malformed production-note fixtures, or extra review gates.

## Related design and source references

The stock Desktop adapter remains a separate design in [DESKTOP-BACKEND-DESIGN.md](DESKTOP-BACKEND-DESIGN.md); it is not part of this headless implementation.

The outline and section rules are in `git show dev:packages/lib/services/ai/tools/utils/noteOutline.ts` and `git show dev:packages/lib/services/ai/tools/global/readNote.ts`. The [official upstream repository](https://github.com/laurent22/joplin) provides the public source history.
