# AI Agent Runtime

Status: Accepted · Owner: `@omnis/agent-runtime` · Sprint: 1

Explicit agent lifecycle, planning and governed execution.

## 1. Responsibilities

- Register and resolve agent descriptors
- Own the agent state machine
- Plan a goal into a step graph
- Drive the plan through the execution kernel
- Publish agent lifecycle events
- Enforce ceilings via compiled constraint policy sets

## 2. State machine

See [AI_AGENTS.md](../03-contracts/AI_AGENTS.md) for the full transition table. The
machine is table-driven: every legal edge is tested; every illegal edge throws.

## 3. Planning

`agentPlanning` expands a goal into steps. Capability model references are **pinned to
concrete models** at plan time so an agent run does not silently change models mid-flight.
Plans that exceed ceilings are rejected with `ValidationError` before any record is
created.

Nested `kind: "agent"` steps are rejected in Sprint 1 (no recursive agents yet).

## 4. Execution

```
createInstance → transition to planning/running
             → kernel.run(plan)
             → evaluate
             → settle state (completed | failed | waiting | cancelled)
```

Model and tool steps are executed only through injected kernel step executors that
call the orchestrator and tool-runtime.

## 5. Events

| Type                      | When                   |
| ------------------------- | ---------------------- |
| `ai.agent.state.changed`  | Every legal transition |
| `ai.agent.step.completed` | Step succeeded         |
| `ai.agent.step.failed`    | Step failed or skipped |

Publishers are guarded: a throwing bus increments a failure counter and does not fail
the run.

## 6. Non-goals (Sprint 1)

- Multi-agent mesh collaboration
- Long-term memory stores
- Streaming token UI for agent steps
- Vendor-specific agent frameworks (LangChain, etc. are forbidden dependencies)
