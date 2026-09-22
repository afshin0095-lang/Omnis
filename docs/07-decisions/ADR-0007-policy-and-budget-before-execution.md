# ADR-0007: Policy and Budget Before Execution

- Status: Accepted
- Date: 2026-09-22
- Sprint: 1
- Related: [AI_POLICIES.md](../03-contracts/AI_POLICIES.md),
  [AI_BUDGETS.md](../03-contracts/AI_BUDGETS.md)

## Context

Privileged and expensive AI work that runs before authorisation or cost control is a
security and financial incident by design. Retries and fallbacks multiply the damage if
gates are only at the outer edge.

## Decision

1. **Policy gate before** any privileged tool or model invocation, including each
   fallback candidate.
2. **Budget reserve before** expensive work; commit or release after.
3. **Fail closed:** a throwing or broken policy engine is `policy_blocked`, never allow.
4. **Precedence:** `deny > require_approval > constrain > allow`.
5. **Money as integer micro-USD**; estimates for holds use known pricing dimensions.
6. **Architecture tests** assert dependency edges from tool-runtime, model-orchestrator
   and execution-kernel to policy-engine and budget-engine.

## Alternatives considered

- **Audit after the fact.** Rejected: cannot un-call a provider or un-spend money.
- **Soft quotas only.** Rejected: soft limits become no limits under load.

## Consequences

- Approval-required paths fail the run into a waiting state; grant starts a child
  execution.
- Cost limits must exceed pre-call estimates or work is refused before the provider.
- Integration suites cover deny, approval, budget block, fail-closed gate and settlement.
