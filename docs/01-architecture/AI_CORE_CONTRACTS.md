# AI Core Contracts Overview

Status: Accepted · Sprint: 1

Index of the contracts that define AI Core shapes and behaviours. Each linked document is
normative for its package; this page exists so a reader can find the right contract without
opening every file.

| Contract                                             | Package owner                       | Settles                               |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------- |
| [AI_CORE_TYPES.md](../03-contracts/AI_CORE_TYPES.md) | `@omnis/ai-core-types`              | Shared vocabulary, JSON safety, money |
| [AI_EXECUTION.md](../03-contracts/AI_EXECUTION.md)   | execution-context, execution-kernel | Scopes, plans, records, results       |
| [AI_MODELS.md](../03-contracts/AI_MODELS.md)         | model-registry                      | References, descriptors, resolve      |
| [AI_PROVIDERS.md](../03-contracts/AI_PROVIDERS.md)   | provider-registry                   | Adapter, lifecycle, selection         |
| [AI_AGENTS.md](../03-contracts/AI_AGENTS.md)         | agent-runtime                       | Descriptors, state machine, planning  |
| [AI_TOOLS.md](../03-contracts/AI_TOOLS.md)           | tool-runtime                        | Descriptors, gated invocation         |
| [AI_POLICIES.md](../03-contracts/AI_POLICIES.md)     | policy-engine                       | Decisions, precedence, fail-closed    |
| [AI_BUDGETS.md](../03-contracts/AI_BUDGETS.md)       | budget-engine                       | Micro-USD, reservations, windows      |
| [AI_EVALUATION.md](../03-contracts/AI_EVALUATION.md) | ai-evaluation                       | Deterministic scores                  |

Architecture companions: [AI_CORE_ARCHITECTURE.md](AI_CORE_ARCHITECTURE.md),
[AI_CORE_RUNTIME.md](AI_CORE_RUNTIME.md), [AI_AGENT_RUNTIME.md](AI_AGENT_RUNTIME.md),
[AI_MODEL_ORCHESTRATION.md](AI_MODEL_ORCHESTRATION.md),
[AI_EXECUTION_KERNEL.md](AI_EXECUTION_KERNEL.md).

Event contracts for the `ai.*` namespace live in `@omnis/events` and are described in
[EVENT_ARCHITECTURE.md](EVENT_ARCHITECTURE.md); the contract test suite
`tests/contract/ai-core-events.test.ts` locks payload shapes.
