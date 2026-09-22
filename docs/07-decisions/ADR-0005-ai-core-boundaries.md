# ADR-0005: AI Core Boundaries

- Status: Accepted
- Date: 2026-09-22
- Sprint: 1
- Related: [ADR-0002](ADR-0002-domain-boundaries.md),
  [AI_CORE_ARCHITECTURE.md](../01-architecture/AI_CORE_ARCHITECTURE.md)

## Context

Sprint 1 introduces twelve packages that decide, govern and record AI work. Without
explicit boundaries, vendor SDKs, UI frameworks and application code will leak into the
core, and the core will grow cyclic dependencies.

## Decision

1. **Twelve AI Core packages**, layered 2–9, with dependencies only downward.
2. **No vendor SDK** in any workspace member. Adapters will own SDKs later; until then
   `ProviderAdapter` is the only provider surface.
3. **Headless core.** AI Core packages import no React, DOM or `@omnis/ui` / `@omnis/theme`.
4. **Composition only at the root.** Only `@omnis/ai-core-runtime` may depend on all
   other AI Core packages.
5. **Mechanical enforcement.** `scripts/check-workspace-health.mjs` and
   `tests/architecture/ai-core-boundaries.test.ts` refuse forbidden edges, vendor
   imports, presentation imports and missing required edges.

## Alternatives considered

- **Single `ai-core` mega-package.** Rejected: prevents independent versioning of
  governance vs execution and forces every consumer to take the whole graph.
- **Allow SDKs behind feature flags.** Rejected: types and retry semantics leak across
  the flag boundary; the health checker cannot see flags.

## Consequences

- New AI capability requires choosing a layer and an owner package.
- Provider integrations are a future Sprint and a future package family.
- Studio talks to AI Core through a transport seam and view-model projection, not by
  importing domain types into React trees.
