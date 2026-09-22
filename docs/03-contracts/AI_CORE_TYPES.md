# AI Core Types

Status: Accepted · Owner: `@omnis/ai-core-types` · Sprint: 1 · Contract version: 1.0.0

The shared vocabulary of every AI execution in OMNIS. This document is the contract;
the implementation is [`packages/ai-core-types`](../../packages/ai-core-types).

## 1. Why a separate vocabulary package

The platform's AI work has a vocabulary that is larger than identifiers and smaller
than any runtime: models, providers, agents, tools, executions, policies, budgets,
evaluations, messages, failures. Putting those types in a runtime package would force
every consumer to depend on that runtime. Putting them in `@omnis/types` would couple
the identity layer to AI-specific shapes. `@omnis/ai-core-types` is the seam: pure data
types, JSON-safe by construction, with no I/O and no side effects.

## 2. What it owns

| Area       | Types                                                                     | Notes                                                                   |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Models     | `ModelReference`, `ModelDescriptor`, pricing, capabilities, modalities    | Reference is a discriminated union: `{kind:"id"\|"slug"\|"capability"}` |
| Providers  | `ProviderDescriptor`, `ProviderHealth`, lifecycle status                  | Adapter interface lives in `@omnis/provider-registry`                   |
| Agents     | `AgentDescriptor`, constraints, tool bindings, instructions               | Constraints compile to policy sets at run time                          |
| Tools      | `ToolDescriptor`, risk level, side effect, parameters                     | Invocation is owned by `@omnis/tool-runtime`                            |
| Execution  | `ExecutionRequest`, `ExecutionRecord`, `ExecutionResult`, steps, attempts | Result is a discriminated union on status                               |
| Policy     | `PolicyDecision` (allow / deny / constrain / require_approval)            | Engine owns evaluation; types own the shape                             |
| Budget     | `Budget`, `Reservation`, `UsageSummary`                                   | Money is integer micro-USD; never floating point                        |
| Evaluation | `EvaluationResult`, `EvaluationScore`                                     | Deterministic rules only in Sprint 1                                    |
| Messages   | `Message`, `ContentPart`                                                  | Discriminated content parts                                             |
| Failures   | `ExecutionFailure`                                                        | Class, code, retryability, attempt, details                             |

## 3. Identifiers

New branded kinds, minted by `@omnis/types`:

| Kind          | Prefix | Owner             |
| ------------- | ------ | ----------------- |
| `model`       | `mdl`  | Model Registry    |
| `provider`    | `prv`  | Provider Registry |
| `tool`        | `tol`  | Tool Runtime      |
| `policy`      | `pol`  | Policy Engine     |
| `budget`      | `bud`  | Budget Engine     |
| `reservation` | `rsv`  | Budget Engine     |
| `evaluation`  | `evl`  | AI Evaluation     |
| `plan`        | `pln`  | Execution Kernel  |

Existing kinds reused without change: `agent` (`agt`), `execution` (`exe`), `tenant`,
`correlation`, `trace`, `span`.

## 4. JSON safety

Every exported value type is JSON-representable. `assertJsonSafe(value, label, maxDepth?)`
rejects `undefined`, functions, symbols, `bigint`, circular structures and non-finite
numbers. A type that cannot round-trip through `JSON.stringify` is not part of this
contract.

## 5. Money

All monetary amounts are **integer micro-USD** (`number` that is a finite integer).
`null` means "not priced" and is distinct from `0` (priced at free). Formatters and
screens must never collapse the two.

## 6. What it deliberately does not own

- Provider adapter interfaces (owned by `@omnis/provider-registry`)
- Runtime state machines (owned by agent-runtime and execution-kernel)
- Event payload schemas (owned by `@omnis/events`)
- React view models (owned by `apps/studio/src/features/ai-core`)

## 7. Dependencies

`@omnis/ai-core-types` depends only on `@omnis/types` and `@omnis/errors`. Nothing in
the presentation layer or any application may be imported here.
