# AI Execution Kernel

Status: Accepted · Owner: `@omnis/execution-kernel` · Sprint: 1

Deterministic planned execution of AI work units.

## 1. What a plan is

A plan is an ordered set of steps with:

- `id`, `name`, `kind` (`model` | `tool` | …)
- `dependsOn` (step ids)
- timeouts, max attempts, optional flag
- input, optional model/provider/tool ids
- metadata

The kernel topologically sorts dependencies and runs steps sequentially in Sprint 1.

## 2. Step executors

The kernel does not know how to call a model or a tool. Callers inject executors keyed
by step kind. `@omnis/ai-core-runtime` supplies the production executors that delegate
to the model orchestrator and tool runtime.

## 3. Guarantees

| Guarantee       | Mechanism                                                        |
| --------------- | ---------------------------------------------------------------- |
| Determinism     | Fixed order; injectable clock; no hidden global state            |
| Isolation       | Per-execution record; child scopes mint new execution ids        |
| Governance      | Policy gate and budget hold before privileged steps              |
| Observability   | Spans (`execution.run`, step spans); attempt trail on the record |
| Terminal safety | Terminal records throw on further mutation                       |
| Cancellation    | Cooperative between steps; reason recorded                       |
| Deadline        | Checked before each step against scope clock                     |
| Hooks           | before/after/onFailure; hook errors do not replace outcomes      |

## 4. Recording

An `ExecutionRecord` holds request, status, plan, attempts, result, governance
(policy outcome, ceiling breach), timeline, evaluation and timestamps. Attempts carry
per-step status, duration, usage and failure.

## 5. Failure classes (selected)

| Class               | Typical cause                                     |
| ------------------- | ------------------------------------------------- |
| `policy_blocked`    | Deny or require_approval                          |
| `budget_blocked`    | Reservation refused                               |
| `deadline_exceeded` | Timeout                                           |
| `cancelled`         | Cooperative cancel                                |
| `execution_failed`  | Step failure                                      |
| `non_retryable`     | Permanent resolution failure (e.g. unknown model) |

## 6. Related

- Contract: [AI_EXECUTION.md](../03-contracts/AI_EXECUTION.md)
- ADR: [ADR-0007](../07-decisions/ADR-0007-policy-and-budget-before-execution.md)
