# Publication and privacy cleanup plan

**Status (2026-10-31):** Independent review found no blockers. Cleanup and focused verification are complete in an independent clone. The sanitized local branch is ready for user review. The original checkout remains unchanged; nothing has been pushed or deployed.

## Goal and boundaries

Prepare the local `feat/headless-service` work for a future public push by removing personal values, deployment-specific records, and other private operational details from the feature's reachable history. The branch has never been published. The reviewed audits found personal contact information, local paths, deployment diaries, and live infrastructure identifiers in tracked files. A targeted history audit found no confirmed plaintext credentials. That result does not establish that the entire upstream history is free of secrets.

Keep the useful implementation history and the upstream merge. Rewrite only commits unique to the feature; leave upstream commit IDs unchanged. Feature commit IDs will change. The private backup and old-to-new commit map will preserve deployment provenance and the original history for private reference. Do not publish the backup, map, replacement lists, or any private audit output.

Treat SOPS-encrypted configuration and its public age recipient as non-secret project material and retain the existing convention. Git commit addresses already use GitHub's noreply format. Do not rotate credentials or move private keys unless evidence of actual exposure creates that need.

## Work sequence

1. **Preserve recovery material.** Outside the publishable checkout, create a private Git bundle containing the original feature ref and a private record of the original deployment configuration. Verify that the bundle contains the expected feature ref and history before changing anything. Create a disposable clone with its own Git directory and perform the remaining steps there, keeping the original checkout and branch untouched. Store the bundle, backup configuration, replacement lists, and old-to-new map outside the publishable repository. The ignored runtime configuration described below is the intentional exception for local use.

2. **Separate local deployment settings from the tracked template.** Copy `extras/cloudflare-mcp-worker/wrangler.jsonc` to the ignored local file `extras/cloudflare-mcp-worker/wrangler.local.jsonc` before sanitizing the tracked file. Replace account-specific and deployment-specific values in the tracked configuration with generic, usable placeholders while preserving binding names and types required by builds, dry runs, and generated types. Ensure the local file is ignored. Update the `dev` and `deploy` npm scripts to pass `--config wrangler.local.jsonc`; retain the existing `sops exec-file` flow, which supplies a temporary decrypted file through `--env-file` for development and `--secrets-file` for deployment. Keep `npm run dev` and `npm run deploy` as the everyday commands. Administrative Wrangler examples, including log tailing and resource management, must select the same local configuration. Document that a fresh clone needs a one-time local configuration copy and setup. Keep the tracked template valid for local type generation and checks.

3. **Clean current content.** Remove account-specific release details from `extras/headless-service/deploy/README.md`, `extras/headless-service/UPSTREAM-UPDATE-PLAN.md`, `extras/headless-service/NOTE-MUTATION-RESULTS-PLAN.md`, `extras/headless-service/SEMANTIC.md`, and `extras/cloudflare-mcp-worker/README.md`. Remove `chatgpt-work/DESKTOP-MCP-PARITY-HANDOFF.md` and `chatgpt-work/SEMANTIC-SEARCH-IMPLEMENTATION-PLAN.md` as operational records from public history, after preserving them privately. Move reusable technical explanations into relevant public documentation only where they remain useful without deployment context. Replace personal values in other audited tracked files, history locations, tests, generated declarations, and messages as applicable. Use reserved example addresses in tests rather than personal contact details. Keep private replacement lists and audit results outside the public tree.

4. **Rewrite history in the disposable clone.** Use an audited, path- and value-scoped history rewrite to remove the private records and replace sensitive literals. Use the separate clone from step 1 rather than a linked worktree, which shares Git storage and refs with its original repository. Use the private installation of `git-filter-repo`; retain the exact scoped command and resulting map with the private execution evidence. Apply replacements separately to commit messages and include other reachable history text in the audit. Audit the publish ref explicitly: a partial rewrite may retain private refs and unreachable original objects, which must never be included in a public push. Do not blindly replay a range from the current merge base: the graph contains an upstream development merge, and the current merge base is that merge's second parent rather than the original fork point. Preserve the upstream merge and meaningful implementation commits. Private-only documentation commits may disappear, so do not promise an exact retained commit count.

5. **Review the rewritten result before publication.** Confirm that reachable public history, not only the working tree, no longer contains the audited personal values, local paths, deployment diaries, or live infrastructure identifiers. Confirm upstream commit IDs remain unchanged, the upstream merge and meaningful implementation history remain, and only the intended feature history has new commit IDs. Compare the application-code diff and confirm changes are limited to the agreed configuration, documentation, and fixtures. Confirm the publish ref does not include the original private branch, bundle, map, or replacement lists. Run focused existing Worker dry-run, type-generation, and relevant tests for the configuration changes; a full headless-service build or redeploy is not required solely for this privacy cleanup.

6. **Prepare a review branch.** Keep the sanitized work on a local branch, proposed name `codex/headless-public`, until the user reviews the concrete result. The eventual push should publish only that branch through the normal workflow; do not push all refs or private backup refs. This plan does not authorize publication. Stop after preparing the reviewable local result and obtain separate authorization before any push.

## Completion criteria

- A verified private bundle and private old-to-new commit map exist outside the publishable checkout, and the original branch remains available for comparison until review.
- Everyday development and deployment commands use the ignored local configuration, while tracked configuration contains only generic values and still supports local checks.
- Public documentation retains reusable design information without personal values or account-specific deployment records; the two operational handoff documents are absent from public history.
- The rewritten reachable history passes the targeted privacy review, retains meaningful implementation and upstream merge history, and leaves upstream commit IDs unchanged.
- Focused existing checks pass, and the sanitized local branch is ready for user review without being pushed.

## Implementation and verification result

- Preserved and verified a complete private bundle of the original feature ref before changing the independent clone. Preserved the original deployment configuration and encrypted sources privately.
- Split the Worker template from the ignored local deployment file. The local file is byte-identical to the original configuration; SOPS ciphertext and the recipient configuration are unchanged.
- Applied path-aware cleanup to historical documentation versions, removed both operational handoff files from reachable history, and replaced audited personal values in file contents and commit messages.
- The rewrite processed 237 original feature commits and two cleanup commits. It retained 210 commits and pruned 29 documentation-only commits. Every original commit touching non-Markdown files remains. The upstream merge and all 16,012 upstream commits retain the required ancestry and original upstream IDs.
- Compared the resulting tree with the original feature tip. Differences are limited to the agreed documentation, Worker configuration/scripts/test identities, and sample embedding endpoint. Application source is unchanged.
- Scanned every object reachable from the sanitized branch, including upstream ancestry, for the audited personal literals and removed file paths: zero findings. This targeted review does not claim to detect every unknown secret format.
- Worker type generation, typechecking, all 15 existing unit tests, the dry-run build and the local workerd OAuth/forwarding workflow passed. The workerd check required loopback access; it used synthetic Google and sidecar responses.
- Preserved the private old-to-new commit map and verification evidence outside the public tree. A final documentation commit records this result after the rewrite.

## Remaining checkpoint

The user reviews the local sanitized branch. Publication requires separate authorization and must select only the sanitized ref. No full headless rebuild, service restart, deployment or public push was required or performed for this cleanup.
