# AI Core Architecture

Status: Accepted · Sprint: 1 · Owners: all `@omnis/ai-*` and related packages

The provider-independent execution architecture every agent, model call and tool
invocation in OMNIS runs on.

## 1. Purpose

Sprint 1 builds the kernel of AI work without binding the platform to any vendor.
When a provider adapter arrives in a later Sprint, nothing above the adapter interface
changes.

## 2. Package map

```
@omnis/ai-core-types          vocabulary (pure data)
@omnis/execution-context      scopes, cancellation, deadlines
@omnis/model-registry         model catalogue
@omnis/provider-registry      provider catalogue + adapter interface
@omnis/policy-engine          authorisation
@omnis/budget-engine          cost ceilings and holds
@omnis/ai-evaluation          deterministic scoring
@omnis/tool-runtime           gated tool invocation
@omnis/execution-kernel       planned step execution
@omnis/model-orchestrator     model call pipeline + fallback
@omnis/agent-runtime          agent lifecycle + planning
@omnis/ai-core-runtime        composition root
```

Plus extensions in `@omnis/events` (`ai.*` namespace), `@omnis/telemetry` (`omnis.ai.*`
attributes) and `@omnis/types` (new identifier kinds).

## 3. Dependency layers

| Layer | Members                                                                            |
| ----- | ---------------------------------------------------------------------------------- |
| 0     | types, theme                                                                       |
| 1     | errors                                                                             |
| 2     | validation, **ai-core-types**                                                      |
| 3     | contracts, config                                                                  |
| 4     | logging, telemetry, events, **execution-context**                                  |
| 5     | **model-registry, provider-registry, policy-engine, budget-engine, ai-evaluation** |
| 6     | ui                                                                                 |
| 7     | **tool-runtime, execution-kernel, model-orchestrator**                             |
| 8     | **agent-runtime**                                                                  |
| 9     | **ai-core-runtime**                                                                |
| 10    | studio                                                                             |

Dependencies point strictly downward. Cycles and same-layer edges fail
`pnpm verify:workspace`.

## 4. Pipeline

```
Studio / API
    ↓
ai-core-runtime          (composition)
    ↓
agent-runtime            (state machine, plan)
    ↓
execution-kernel         (steps)
    ↙              ↘
model-orchestrator   tool-runtime
    ↓                    ↓
provider adapter     tool handler
(interface only)     (injected)
```

Every privileged path passes **policy** then **budget** before work. Evaluation runs
after. Events and spans record what happened.

## 5. Hard invariants

1. No vendor SDK in any workspace package (enforced by health checker + architecture tests).
2. Agents never call providers or tools directly.
3. Policy before privileged execution; budget before expensive work.
4. Failures are typed (`ExecutionFailure`), never silent.
5. Retries are classified and bounded; no unbounded backoff.
6. Secrets are redacted before logs, events and errors serialise.
7. Money is integer micro-USD; `null` ≠ `0`.
8. AI Core packages are headless (no React, no DOM).

## 6. Studio integration

`apps/studio/src/features/ai-core` is a **projection layer**:

- `types.ts` — view models and pure formatters (no domain imports)
- `client.ts` — transport seam + shape-checked mappers + `AiCoreResult` (never throws)
- `mockRuntime.ts` — deterministic stand-in backend

When a real backend arrives, only the transport implementation changes.

## 7. Related documents

- [AI_CORE_RUNTIME.md](AI_CORE_RUNTIME.md)
- [AI_AGENT_RUNTIME.md](AI_AGENT_RUNTIME.md)
- [AI_MODEL_ORCHESTRATION.md](AI_MODEL_ORCHESTRATION.md)
- [AI_EXECUTION_KERNEL.md](AI_EXECUTION_KERNEL.md)
- Contracts under `docs/03-contracts/AI_*.md`
- ADRs 0005–0009
