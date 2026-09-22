# AI Agents

Status: Accepted · Owner: `@omnis/agent-runtime` · Sprint: 1

What an agent is, how it is described, and the lifecycle it may pass through.

## 1. Descriptor

An `AgentDescriptor` carries identity, kind, status, version, capabilities,
instructions, default model reference, tool bindings, memory slots, constraints,
optional policy/budget bindings and metadata.

Constraints (ceilings):

| Field                          | Policy kind compiled at run time |
| ------------------------------ | -------------------------------- |
| `maxSteps`                     | `max_steps`                      |
| `maxModelCalls`                | `max_model_calls`                |
| `maxToolCalls`                 | `max_tool_calls`                 |
| `maxDurationMs`                | `max_duration_ms`                |
| `maxCostMicroUsd`              | `max_cost_micro_usd`             |
| `maxRetriesPerStep`            | `max_retries`                    |
| `allowedTools` / `deniedTools` | tool allow/deny lists            |
| `approvalRequiredAtRisk`       | risk-level approval gate         |

Constraint policy sets are named `agent-constraints:<slug>` and sourced as
`agent:<slug>@<version>`. They are registered lazily when a run starts.

## 2. State machine

Legal transitions:

| From       | To                                                      |
| ---------- | ------------------------------------------------------- |
| `created`  | `ready`, `failed`, `cancelled`                          |
| `ready`    | `planning`, `running`, `paused`, `failed`, `cancelled`  |
| `planning` | `running`, `waiting`, `paused`, `failed`, `cancelled`   |
| `running`  | `waiting`, `paused`, `completed`, `failed`, `cancelled` |
| `waiting`  | `running`, `paused`, `failed`, `cancelled`              |
| `paused`   | `ready`, `running`, `failed`, `cancelled`               |

Illegal transitions throw. Terminal states (`completed`, `failed`, `cancelled`) do not
leave.

## 3. Pipeline

```
Observe → Plan → Policy → Budget → Kernel (model/tool steps) → Evaluate → Settle
```

The agent runtime **never** calls a provider or a tool handler directly. Model steps
go through the Model Orchestrator; tool steps go through the Tool Runtime; both go
through the Execution Kernel.

## 4. Planning

The planner expands the goal into a step plan and **pins** capability model references
to concrete models at planning time. Mid-run provider fallback is a property of direct
`executeModel` calls, not of agent runs.

## 5. Approval

A policy outcome of `require_approval` fails the run with a waiting instance. Granting
approval starts a **child** execution (attempt 2). Refusing resolves failed.
`approveAgent(id, null)` throws `ValidationError` synchronously.

## 6. Events

`ai.agent.state.changed`, `ai.agent.step.completed`, `ai.agent.step.failed` are published
through a guarded publisher: a throwing bus must not fail the run.
