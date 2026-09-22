# AI Policies

Status: Accepted · Owner: `@omnis/policy-engine` · Sprint: 1

How privileged work is authorised before it runs.

## 1. Decision shape

`PolicyDecision` is a discriminated union:

| Kind               | Meaning                              |
| ------------------ | ------------------------------------ |
| `allow`            | Proceed                              |
| `deny`             | Refuse; work must not start          |
| `constrain`        | Proceed under additional constraints |
| `require_approval` | Refuse until a human grants approval |

## 2. Precedence

When multiple rules apply, the outcome is the **most restrictive**:

```
deny > require_approval > constrain > allow
```

Evaluation is deterministic: same inputs, same decision, same details.

## 3. Gate semantics

`gate()` is the fail-closed entry point. If the engine throws or is broken, the call
is treated as `policy_blocked` — never as an implicit allow. Integration tests install
a throwing stub over a real engine via `Object.assign` to prove this.

## 4. Conditions and defaults

Rules may carry conditions (actor, tool risk, model capability, …). Default policies
exist for common denials. Agent constraint sets are compiled from descriptor ceilings
and registered lazily at run time (see [AI_AGENTS.md](AI_AGENTS.md)).

## 5. Events

`ai.policy.decision.recorded` and `ai.policy.violation.detected` carry the decision
without embedding secrets or full request payloads.

## 6. Invariant

**Policy is evaluated before any privileged execution.** The health checker and the
architecture test suite both refuse dependency edges that would let agent-runtime,
tool-runtime or model-orchestrator skip the policy engine.
