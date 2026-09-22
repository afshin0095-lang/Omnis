# ADR-0008: Explicit Agent State Machine

- Status: Accepted
- Date: 2026-09-22
- Sprint: 1
- Related: [AI_AGENTS.md](../03-contracts/AI_AGENTS.md),
  [AI_AGENT_RUNTIME.md](../01-architecture/AI_AGENT_RUNTIME.md)

## Context

Agent frameworks often encode lifecycle as ad-hoc flags (`isRunning`, `isPaused`) or
implicit loops. That makes illegal transitions silent, approvals ambiguous and audits
unreliable.

## Decision

1. **Table-driven state machine** with named states: `created`, `ready`, `planning`,
   `running`, `waiting`, `paused`, `completed`, `failed`, `cancelled`.
2. **Only listed transitions are legal**; others throw typed errors.
3. **Every transition emits** `ai.agent.state.changed` (publisher failures do not fail the run).
4. **Ceilings compile to policy sets** at run start, not as informal checks inside the loop.
5. **No unbounded loop:** max steps, duration, cost, model calls, tool calls and retries
   are enforced.
6. **Agents never call providers or tools directly** — only through the kernel's executors.

## Alternatives considered

- **Library state machines (XState, etc.).** Deferred: adds a dependency for a small,
  fully-tested table we own.
- **Implicit status strings.** Rejected: untestable illegal edges.

## Consequences

- Unit tests cover every legal and illegal edge.
- Waiting-for-approval is a first-class state, not a side channel.
- Sprint 2 Character OS can attach identity without rewriting the lifecycle.
