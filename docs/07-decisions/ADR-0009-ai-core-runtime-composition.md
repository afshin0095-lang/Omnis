# ADR-0009: AI Core Runtime Composition

- Status: Accepted
- Date: 2026-09-22
- Sprint: 1
- Related: [AI_CORE_RUNTIME.md](../01-architecture/AI_CORE_RUNTIME.md),
  [ADR-0005](ADR-0005-ai-core-boundaries.md)

## Context

Applications need one entry point to register catalogue entries and run AI work. If every
app wires twelve packages itself, wiring drifts and governance gets skipped.

## Decision

1. **`@omnis/ai-core-runtime` is the composition root** (layer 9): the only package that
   depends on the full AI Core graph.
2. **Façade API** for register / execute / evaluate / cancel / approve / health.
3. **Injected step executors** connect the kernel to orchestrator and tool-runtime inside
   this package — not inside the kernel.
4. **Studio does not import the runtime into React components directly for domain types.**
   It uses a transport + view-model feature (`apps/studio/src/features/ai-core`) so UI
   stays a projection. The mock transport stands in until a backend exists.
5. **Health is computed**, not configured: counts and capability flags derived from
   registries.

## Alternatives considered

- **DI container framework.** Rejected for Sprint 1: explicit constructors are enough and
  stay greppable.
- **Apps import every package.** Rejected: guarantees inconsistent wiring.

## Consequences

- New engines are added by extending the runtime factory, not by teaching every app.
- Tests build platforms via `testSupport` helpers with fake clocks and adapters.
- A future HTTP/API layer can sit on the same façade without changing engines.
