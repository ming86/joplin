# Headless service work

These instructions apply when adding or changing headless-service functionality in `extras/headless-service`, the separate `extras/cloudflare-mcp-worker` project, or the headless integrations in `packages/app-cli` and `packages/lib`.

- Keep Joplin's existing application behavior in its upstream monorepo and reuse its native synchronization, E2EE, and data models.
- Put service features and adapters in `extras/headless-service`; keep `extras/cloudflare-mcp-worker` a separate project.
- Preserve upstream structure and keep necessary changes in `packages/app-cli` or `packages/lib` focused so future upstream updates remain manageable. Add a native primitive when the existing API cannot correctly meet a requirement, such as an atomic revision-guarded note save.
- See [the headless service README](extras/headless-service/README.md) for the architecture rationale and current contracts.
