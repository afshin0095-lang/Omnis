# AI Core Runtime

Status: Accepted · Owner: `@omnis/ai-core-runtime` · Sprint: 1

The composition root of the AI Core: one package applications depend on to register
catalogue entries and run work.

## 1. Role

`AiCoreRuntime` wires registries, engines, kernel, orchestrator, agent runtime,
evaluation, telemetry and the event bus into a single façade. It is the only AI Core
package that is allowed to depend on all of the others (layer 9).

## 2. Public surface (conceptual)

| Operation                                                               | Behaviour                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `registerModel` / `registerProvider` / `registerAgent` / `registerTool` | Catalogue writes                                                  |
| `executeAgent`                                                          | Plan → govern → kernel → evaluate                                 |
| `executeModel`                                                          | Direct orchestrated model call (no kernel record unless composed) |
| `executeTool`                                                           | Gated tool invocation                                             |
| `evaluate`                                                              | Deterministic evaluation of a result                              |
| `getExecution`                                                          | Lookup of a recorded execution                                    |
| `cancelExecution`                                                       | Cooperative cancel of an in-flight run                            |
| `approveAgent`                                                          | Continue or refuse a waiting run                                  |
| `health`                                                                | Counts + capability flags (`canCallModels`, …)                    |

## 3. Health

`AiCoreHealth` reports counts (models, providers, tools, agents, policy sets, budgets,
rule sets, executions, agent instances, publish failures) and booleans:

- `canCallModels` — at least one model and one selectable provider
- `canInvokeTools` — at least one invocable tool
- `canRunAgents` — at least one ready agent plus the above as needed
- `publishing` — event bus is accepting publishes

## 4. Wiring rules

- Default budget and policy sets live in the **same** engines the composition uses.
- Tracer and clock are injectable for tests (deterministic fake clocks).
- Event publish failures are counted, not thrown into the caller's path.
- Step executors for model and tool kinds are provided by this package and passed into
  the kernel; they call orchestrator / tool-runtime, never vendors.

## 5. What it is not

- Not a HTTP server
- Not a UI
- Not a place for vendor SDKs
- Not a god object that reimplements engines — it composes them
