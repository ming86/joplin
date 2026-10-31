# Headless service documentation structure plan

**Status: original documentation cleanup committed; authorized lowercase filename follow-up implemented and pending commit.** The user approved the original documentation cleanup on 2026-10-31. This document preserves that historical plan and records the later filename follow-up.

## Purpose and scope

Keep the service README as the entry point, put maintained technical guides under `docs/`, and distinguish reusable project guidance from deployment-specific operations. Preserve the rationale for the headless additions and the evidence needed to understand their behavior, while removing redundant completed work records from the shared source tree.

This is a documentation-only change. It does not change application behavior, tests, container images, packaging, build recipes, or deployment. Do not edit `extras/cloudflare-mcp-worker` as part of this organization.

## Agreed decisions

### Explain why the headless work lives here

Extend `extras/headless-service/README.md` with the architectural rationale for the additions. Joplin's upstream monorepo remains the source of the existing application and behavior. The headless service reuses Joplin's native sync, E2EE, and models. Keeping the patch surface focused makes future upstream integration manageable. External service features belong in `extras/headless-service`; the separate `extras/cloudflare-mcp-worker` remains its own project. Native changes in `packages/app-cli` or `packages/lib` are appropriate when the existing API cannot correctly satisfy a requirement; atomic revision-guarded note saves are one concrete example.

Use only current, supportable rationale. The early design record is in untracked local `chatgpt-work` material, so the cleanup must not depend on it. Do not copy private operational values into tracked documentation.

### Scope repository guidance narrowly

Add a concise repository-root `AGENTS.md` for headless-service additions across `packages/` and `extras/`. It should state the architectural constraints above and link to the service README for context. Do not add `AGENTS.md` files under `extras/` or individual components now. Keep the guidance specific to this work: no generic boilerplate, new testing or approval gates, or blanket ban on native changes.

### Keep the entry point, relocate maintained guides

Keep `extras/headless-service/README.md` at the package root and move these five maintained guides into `extras/headless-service/docs/`, preserving their filenames:

- `MCP.md`
- `SEMANTIC.md`
- `MULTI-USER.md`
- `WEB.md`
- `CLIPPING.md`

Move the active stock Desktop backend proposal to `extras/headless-service/docs/design/DESKTOP-BACKEND-DESIGN.md`. Keep generic image and runtime-contract documentation in `extras/headless-service/deploy/README.md`; actual host provisioning, Quadlet operations, and backup runbooks belong in a separate deployment repository. Refer to that repository generically. Do not put personal paths, hostnames, identifiers, or other private deployment values in this plan or the reorganized docs.

Preserve the distinction between Joplin's built-in Desktop MCP adapter and the separate headless service contracts. Update only references affected by these moves; do not turn this into a repository-wide README or index rewrite. Joplin publishes its `readme` content to the help site, so that directory is not a general destination for this material.

### Resolve working records by their content

Review each plan and handoff individually. First record any durable decision or contract that is missing from maintained documentation. Remove redundant completed plans from the current tree once their useful content has been transferred; Git history retains prior versions. Preserve any needed session or publication records privately before removing shared copies. Do not create a blanket archive.

Keep active design proposals under `docs/design/` and deferred work in `BACKLOG.md`. Retain historical evidence where it provides useful, reproducible provenance or checks. A filename containing `PLAN`, or the age of a file, is not by itself a deletion reason.

Apply that rule to the current records as follows:

| Record | Intended handling |
| --- | --- |
| `DESKTOP-BACKEND-DESIGN.md` | Keep as an active proposal and move under `docs/design/`. |
| `NOTE-MUTATION-RESULTS-PLAN.md` and `UPSTREAM-UPDATE-PLAN.md` | Treat as completed implementation plans. Transfer any missing durable decisions, then remove them if the remaining material is redundant. |
| `PUBLICATION-PRIVACY-PLAN.md` | Treat as a completed cleanup record. Preserve any needed session or publication material privately before removing the shared copy. |
| `CODEX-PHASE4-VALIDATION.md`, `CODEX-PHASE5-VALIDATION.md`, and dated files under `evidence/` | Review for reproducible provenance and checks; retain useful evidence and update maintained guides that currently point to handoffs. |
| `BACKLOG.md` | Keep deferred work there; it is not a completed plan to archive or remove. |

Before editing semantic-search wording, reconcile the service README's completed-indexing statement with the pending full-indexing or recovery language in `MCP.md`. Verify that they describe the same scope and evidence; do not promote private deployment values into public docs. If the evidence leaves a material uncertainty about what the docs should claim, surface that decision under the existing user-consultation policy.

## Original planned organization

The tree below records the original approved plan before the lowercase filename follow-up. Its uppercase filenames remain here as historical plan details.

After implementation, the relevant structure should be:

```text
AGENTS.md
extras/
  headless-service/
    README.md
    BACKLOG.md
    docs/
      MCP.md
      SEMANTIC.md
      MULTI-USER.md
      WEB.md
      CLIPPING.md
      design/
        DESKTOP-BACKEND-DESIGN.md
        DOCUMENTATION-STRUCTURE-PLAN.md
    deploy/
      README.md
    evidence/
      # retain useful reproducible records after content review
```

This is a target for the documentation work, not a claim that these paths or the root guidance already exist.

## Implementation sequence

1. Add the architectural rationale to the service README and create the narrowly scoped root `AGENTS.md` guidance. Keep native changes framed as justified where they are needed for correct behavior.
2. Move the maintained guides and active Desktop proposal. Repair relative links and anchors in the moved files, the service README, and deployment notes, including the README's existing `deploy/README.md#current-deployment-state` link whose target heading is absent. Check script or packaging references that mention moved paths. Leave runtime and build behavior unchanged; do not alter the container or packaging recipe to accommodate the documentation moves.
3. Review each working record against maintained docs. Transfer missing durable content, privately preserve required session or publication material, then remove only redundant or inappropriate shared records. Keep useful evidence and active backlog items.
4. Inspect the final diff and verify local links, anchors, moved paths, and absence of private deployment information. Do not run application builds or deployments, rewrite history, or add tests for this documentation-only change.

The proposed commit boundary is two coherent changes: first the architecture rationale and root guidance; second the document moves, link repairs, and working-record cleanup. Commit status is recorded with the implementation result below.

## Acceptance criteria

- The service README explains why the headless additions preserve and reuse Joplin's native capabilities, why the patch surface stays focused, where external features live, and when a native change is warranted.
- Root guidance applies specifically to headless additions across `packages/` and `extras/`; no nested guidance files or generic gates are added.
- The service README remains the entry point, the five maintained guides and Desktop proposal have the planned destinations, and deployment documentation stays generic and reusable.
- Built-in Desktop MCP and headless-service behavior remain clearly distinct. Active proposals, deferred backlog, and useful reproducible evidence remain available.
- References to relocated content resolve, and no private deployment details are added.
- The change contains documentation only; it does not alter application, container, packaging, build, or deployment behavior.

## Review result

Independent rubber-duck review on 2026-10-31 found no substantive issues with the plan. Targeted inspection covered the existing guides, work records, package metadata, and container copy rules. This review assessed the plan; implementation verification is recorded separately below.

## Implementation result

Completed on 2026-10-31. The root `AGENTS.md` and service README now state the upstream-maintenance boundary. The five maintained guides and the stock Desktop backend proposal are at their planned destinations. The container guide describes the reusable runtime contract, and host-specific operations remain the responsibility of the deployment repository.

Before cleanup, all 19 original tracked service Markdown files were preserved privately with a SHA-256 manifest. Missing durable information was transferred into the guides: the generic library versus revision-aware MCP creation paths, conflict-copy synchronization eligibility, and the completed historical local browser and two-account acceptance with their limits. The five superseded plan/handoff records and two duplicate Codex result snippets were removed. The three distinct evidence reports and all four deferred backlog observations were retained.

Semantic status wording now directs readers to the configured account's `get_status` result instead of maintaining contradictory deployment snapshots. Poll timing distinguishes the configurable core interval from the independent semantic event feed. Local link and reference checks passed, and the changed files contain documentation only. Validation did not include application tests, builds, deployments, or history rewrites.

Independent rubber-duck review of the completed cleanup on 2026-10-31 found one documentation inconsistency: the `list_conflicts` table retained a blanket statement that conflicts never synchronize, contradicting the detailed synchronization eligibility rules. The table was corrected to match the detailed contract. The reviewer found no other substantive information loss, unsupported acceptance claims, overbroad instructions, or scope expansion. The review compared removed records with maintained guides and checked historical acceptance summaries against their original reports.

## Lifecycle of this plan

This plan is retained for review of the documentation cleanup and its filename follow-up. Durable architectural decisions now live in the service README and root guidance. After the follow-up is reviewed and recorded in Git, remove this plan if it no longer serves a purpose; it is not intended as a permanent archive by default.

## Follow-up: lowercase current filenames (2026-10-31)

The user authorized lowercasing the current documentation filenames on 2026-10-31, after the original cleanup was committed. The filesystem renames and current Markdown link updates are implemented; this follow-up is pending commit.

Current names are `backlog.md`, `docs/mcp.md`, `docs/semantic.md`, `docs/multi-user.md`, `docs/web.md`, `docs/clipping.md`, `docs/design/desktop-backend-design.md`, and `docs/design/documentation-structure-plan.md`. `README.md` and `AGENTS.md` retain their conventional uppercase names. Dated evidence filenames are unchanged.

The uppercase paths above remain as historical original-plan references; the maintained service documentation now links to the current lowercase paths.
