# Note mutation result contract: design and implementation plan

## Goal and scope

Give the existing headless MCP `create_note` and `update_note` tools a consistent acknowledgment that identifies the committed native note revision and, when a body was written, reports exact measurements of the saved body. Keep the existing tool names and input behavior.

This plan covers the headless-service contract and its native Joplin action path. It does not change stock Joplin Desktop behavior or the generic Data API creation path used by other service consumers.

## Agreed result contract

Both successful mutation results require `id`, `updated_time`, and `revision_id`. `updated_time` is a Unix epoch timestamp in milliseconds. `revision_id` is the native Joplin revision for the exact committed note snapshot.

| Tool | Required result fields | Body measurements |
| --- | --- | --- |
| `create_note` | `id`, `title`, `notebook_id`, `updated_time`, `revision_id` | Always include all four measurements, including when the input body is omitted or empty. |
| `update_note` | `id`, `updated_time`, `revision_id`, `previous_revision_id`, `changed` | Include all four when any body input is supplied; omit all four for metadata-only updates. |

The four measurements are `body_length` in UTF-16 code units, `body_size_bytes` in UTF-8 bytes, `body_sha256` as lowercase SHA-256 hex over UTF-8, and `body_total_line_count` using the existing line-count rules. CRLF is one break; LF and lone CR are each one break; a trailing break adds a final empty line; an empty body has one line.

Create results do not include `previous_revision_id` or `changed`. Update keeps `previous_revision_id` nullable and `changed` boolean. A no-op update keeps the timestamp and revision unchanged, reports that revision as both the current and previous revision, and still runs the existing revision precondition checks.

For update results, body input means the presence of any of `body`, `body_file`, `body_patch`, `replace_text`, `prepend`, or `append`, including an empty body replacement, an empty append/prepend, or a successful matched no-op. This rule applies only to successful requests: missing or ambiguous replacement/patch matches retain their existing errors. Metadata-only updates omit every body measurement.

Calculate measurements from the native operation's returned committed snapshot, which also supplies the revision. Do not reread the note after saving or calculate measurements only from submitted input. Results never echo the full body.

## Current implementation points

- The MCP output schemas live in `extras/headless-service/src/mcp/output-schemas.mjs`; `create_note` currently returns only `id`, `title`, and `notebook_id`, while `update_note` conditionally allows the measurements.
- MCP handlers and the local `bodyMetadata` helper live in `extras/headless-service/src/mcp/tools.mjs`. The update handler currently measures only a `body_file` result.
- The account service's generic `createNote` implementation lives in `extras/headless-service/index.mjs`. It validates the destination and then calls the generic backend's `createNote` method.
- The generic backend creation path in `extras/headless-service/src/joplin.mjs` avoids media extraction by POSTing an empty body and then PUTting the supplied body. Keep that behavior for its existing callers.
- Revision-aware operations already travel through `extras/headless-service/src/revisions.mjs`, `extras/headless-service/src/revision-client.mjs`, and the fixed native action catalog in `packages/app-cli/app/headless/revisions.ts`.
- `packages/app-cli/app/app.ts` registers the fixed action catalog from `runHeadlessService`; the new native create action must be registered there through the existing catalog.
- `packages/lib/services/HeadlessNoteService.ts` already prepares revisions and commits guarded note updates with `Note.save` and `nextQueries` in one native transaction. Its `prepareCapture` and snapshot checks are the reference for the new-create path.

## Implementation plan

### 1. Add an atomic native create action

Add a revision-aware `createNoteWithRevision` operation to `HeadlessNoteService` and expose it through the fixed action catalog. Keep it distinct from the existing generic Data API `createNote` method.

The native action should validate the title, destination notebook, and supported create fields at the native boundary. It should use the same notebook availability, write permission, and default-field behavior as current headless creation.

Reuse the native revision capture machinery. Assign the note ID before capture, mark the single `Note.save` with `isNew: true`, and prepare the complete normalized note snapshot before building the first revision. Seed the timestamps and fields that `Note.save` or `BaseModel` would otherwise supply later, including source fields and native defaults, so the revision represents exactly the note that is persisted.

Commit the note and its first native revision with one `Note.save` call and its `nextQueries`. Do not create an empty note and then perform a second body write. Preserve native timestamp handling, permission checks, and `ItemChange` behavior so sync observes the creation normally. Store the supplied body as Markdown text without sending it through the media-extracting Data API POST route.

Return the created note and its native `revision_id` from that committed operation. Validate the committed response at the client boundary, including its native ID, revision ID, timestamp, and saved body. If persistence may have succeeded but the response is malformed or incomplete, report the existing unknown-write outcome rather than inventing a successful result.

### 2. Route MCP creation through the narrow revision-aware path

Add the `createNoteWithRevision` action to the existing revision client and account-service adapter. Preserve the current account-side validation and notebook selection rules, then call the native action only for MCP `create_note`.

Keep the generic `createNote` account/backend path and its Data API behavior available to unrelated service consumers. Do not make those callers require the optional headless native extension.

Update the MCP create handler to build `bodyMetadata` from the exact body returned with the committed native revision. Return the existing title and notebook fields along with the agreed common fields and all four body measurements. Continue to omit body content from the result.

### 3. Return update measurements for every body operation

In the MCP update handler, record whether a body operation was supplied before converting `body_file` into its downloaded string body. After the revision-aware update returns, calculate measurements from the body in that same returned snapshot whenever one of the six body inputs was present.

Keep the current compact result for metadata-only updates. Require a saved body in the returned snapshot when measurements are due; if the write may already have committed but that snapshot is unavailable, use the existing `write_outcome_unknown` error behavior.

Keep update preconditions, body-mode validation, patch and exact-replacement semantics, no-op handling, error envelopes, and conflict behavior unchanged. Do not add an automatic retry.

### 4. Align schemas and tool descriptions

Update `create_note` output schema to require the common fields, existing `title` and `notebook_id`, and all four body measurements.

Update `update_note` output schema so its common fields remain required and its conditional branch requires either none or all four measurements. Keep `previous_revision_id` nullable and `changed` required.

Revise tool descriptions to explain that create always reports measurements, while update reports them for any body operation and omits them for metadata-only edits. Retain the existing body-file guidance and exact measurement definitions. Do not add a separate `edit_note` tool or change input schemas for this result-contract work.

Update `extras/headless-service/index.d.mts` for the narrow revision-aware create method and its result, and update `extras/headless-service/MCP.md` and comments on directly modified symbols. Preserve the existing generic creation types. Explain that a create response's `revision_id` can immediately serve as the next update's `base_revision_id`.

### 5. Focused regression and native verification

Extend the existing focused coverage rather than adding a new test framework or broader test infrastructure.

- Update `extras/headless-service/tests/note-fields-tools.test.mjs`, `note-file-tools.test.mjs`, `create-note-file-tools.test.mjs`, and `mcp-output-schemas.test.mjs` for exact result keys, schema branches, omitted and empty create bodies, and body-operation presence rules.
- Update `extras/headless-service/tests/revisions.test.mjs` and `mcp-parity.test.mjs` for action transport, native create acknowledgment, and the unchanged metadata-only result shape.
- Extend `packages/app-cli/tests/headless/revisions.test.cjs` for fixed-action registration, request validation, and safe write error envelopes.
- Extend `packages/lib/services/HeadlessNoteService.test.ts` to show that creation saves the note and first native revision atomically, that the first later edit links to that revision, and that a failed native transaction leaves neither a partial note nor a partial revision.
- Extend `extras/headless-service/tests/mcp-native.test.mjs` to compare create and update acknowledgments with the native saved body and revision, including UTF-16 versus UTF-8 measurements, line endings, empty bodies, a body no-op, and a metadata-only update.
- Cover all six update body inputs through the shared measurement path; keep stale revision conflicts and existing error outcomes intact.

Use the existing repository test commands for these focused suites and the existing native integration route. No benchmarks, new test harness, rollout gates, limits, configuration layer, or logging subsystem are part of this work.

## Operational and compatibility constraints

Preserve native defaults, timestamps, permissions, and local-sync `ItemChange` behavior. Preserve the generic Data API creation path for non-MCP callers. Keep diagnostics on existing safe error paths and do not log note bodies or file payloads.
