# AI Execution

Status: Accepted · Owners: `@omnis/execution-context`, `@omnis/execution-kernel` · Sprint: 1

How one unit of AI work is scoped, planned, run and recorded.

## 1. Two contexts, deliberately

OMNIS already had a contracts-level `ExecutionContext` (tenant, actor, correlation).
AI Core adds a richer **execution scope** in `@omnis/execution-context`:

| Concern      | Behaviour                                                                     |
| ------------ | ----------------------------------------------------------------------------- |
| Cancellation | `CancellationToken` — cooperative, never forced                               |
| Deadline     | Deterministic, timer-free; compared against a clock the caller supplies       |
| Child scopes | Mint a new `executionId`; inherit tenant and correlation; isolate metadata    |
| Metadata     | Redaction-aware; secret-looking keys are stripped before they leave the scope |
| Bridge       | `ContractContext` maps to/from the contracts `ExecutionContext`               |

The contracts context remains the cross-domain shape. The AI scope is what kernel,
orchestrator and agent runtime hold while work is in flight.

## 2. Execution request

An `ExecutionRequest` carries:

- identity (`id`, `correlationId`, `causationId`, `traceId`, `tenantId`)
- kind (`agent` | `model` | `tool` | `plan`)
- subject (`agentId` / `model` / `tool`)
- `input` as `Readonly<JsonObject>`
- mode, priority, optional policy and budget bindings
- optional deadline

## 3. Kernel

`@omnis/execution-kernel` runs a plan as a **sequence of steps with declared
dependencies**. It does not call providers or tools itself: step executors are injected.

| Guarantee           | How                                                                                |
| ------------------- | ---------------------------------------------------------------------------------- |
| Deterministic order | Topological walk of `dependsOn`; no parallel fan-out in Sprint 1                   |
| Failure propagation | A required step failure fails the execution; optional steps may be skipped         |
| Cancellation        | Cooperative check between steps; terminal records refuse further mutation          |
| Deadline            | Enforced against the scope clock before each step                                  |
| Budget              | Reservation before expensive steps; settlement after                               |
| Policy              | Gate before privileged steps                                                       |
| Hooks               | `beforeStep` / `afterStep` / `onFailure`; hook errors do not replace step outcomes |
| Recording           | Every attempt is appended; the record is the audit trail                           |

## 4. Statuses

Execution statuses include at least: `pending`, `running`, `waiting`, `succeeded`,
`failed`, `cancelled`. Terminal statuses refuse further transitions
(`executionAlreadyTerminal`).

## 5. Result

`ExecutionResult` is a discriminated union on `status`. Success carries `output` and
`usage`; failure carries `ExecutionFailure` with class, code, retryability and details.
Usage is folded across attempts via `totalRecordUsage`.

## 6. What the kernel never does

- Import a vendor SDK
- Call a tool handler directly (tool-runtime owns that)
- Call a provider adapter directly (model-orchestrator owns that)
- Bypass policy or budget
- Retry unboundedly
