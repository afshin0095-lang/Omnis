# ADR-0006: Provider-Independent Model Orchestration

- Status: Accepted
- Date: 2026-09-22
- Sprint: 1
- Related: [ADR-0005](ADR-0005-ai-core-boundaries.md),
  [AI_MODEL_ORCHESTRATION.md](../01-architecture/AI_MODEL_ORCHESTRATION.md)

## Context

Calling a model is the most vendor-shaped operation in the platform. If domain code
imports OpenAI or Anthropic types, every failure class, token field and streaming event
becomes a migration problem when a second vendor is added.

## Decision

1. **`ProviderAdapter` interface** in `@omnis/provider-registry` is the only I/O surface.
2. **`@omnis/model-orchestrator`** owns selection, policy/budget gating, retry, fallback,
   streaming, usage normalisation and events.
3. **OMNIS request/response types** (`ModelRequest`, `ModelResponse`, stream events) are
   the currency above the adapter. Vendor payloads stop at the adapter.
4. **No SDK dependency** is declared or imported anywhere in Sprint 1.
5. **Fallback re-validates** policy and budget on every candidate.

## Alternatives considered

- **Thin wrapper per vendor in domain packages.** Rejected: multiplies types and makes
  policy/budget easy to skip.
- **Direct SDK calls from agent-runtime.** Rejected: agents would bypass orchestration,
  telemetry and governance.

## Consequences

- Sprint 1 tests use in-memory fake adapters.
- Real providers ship as separate packages later, implementing `ProviderAdapter`.
- Capability-based model references resolve before the adapter is called.
