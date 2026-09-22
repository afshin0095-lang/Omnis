/**
 * Policy engine errors.
 *
 * Two families live here, and the split matters:
 *
 * - **Shape failures** (`invalid*`, `duplicate*`, `*NotFound`, `*CapacityExceeded`) mean the
 *   policy set or the identifier is wrong. They are programming or configuration errors,
 *   discovered before anything privileged happens.
 * - **Gate failures** ({@link policyDenied}, {@link policyApprovalRequired}) mean the policy
 *   worked exactly as written and said no. They carry the decision, so an audit row and a
 *   user-facing message can both be built from the error alone.
 *
 * Neither family ever embeds the evaluation attributes: those can contain request text and
 * identifiers that must not travel through an error message into a log line.
 */

import { ConflictError, NotFoundError, PolicyViolationError, ValidationError } from "@omnis/errors";
import type { PolicyDecision, PolicyId, PolicyOutcome } from "@omnis/ai-core-types";
import { describePolicyDecision } from "@omnis/ai-core-types";

/** A policy set that is not registered. */
export function policySetNotFound(policyId: PolicyId): NotFoundError {
  return new NotFoundError("policy-set", policyId, {
    retryable: false,
    metadata: { registry: "policy" },
  });
}

/** A policy set identifier that is already registered. */
export function duplicatePolicySet(policyId: PolicyId, name: string): ConflictError {
  return new ConflictError(`policy:${policyId}`, `policy set "${name}" is already registered`, {
    retryable: false,
    metadata: { policyId, name, registry: "policy" },
  });
}

/** Two rules in the same set claim the same identifier. */
export function duplicatePolicyRuleId(policyId: PolicyId, ruleId: string): ConflictError {
  return new ConflictError(
    `policy-rule:${ruleId}`,
    `policy rule "${ruleId}" is already defined in ${policyId}`,
    {
      retryable: false,
      metadata: { policyId, ruleId },
    },
  );
}

/** A policy set that cannot be stored as given. */
export function invalidPolicySet(
  reason: string,
  policyId: PolicyId | null = null,
): ValidationError {
  return new ValidationError(`policy set is invalid: ${reason}`, {
    retryable: false,
    metadata: { policyId, registry: "policy" },
  });
}

/** A rule that cannot be stored as given. */
export function invalidPolicyRule(ruleId: string, reason: string): ValidationError {
  return new ValidationError(`policy rule "${ruleId}" is invalid: ${reason}`, {
    retryable: false,
    metadata: { ruleId },
  });
}

/** Too many policy sets for the configured capacity. */
export function policySetCapacityExceeded(capacity: number): ConflictError {
  return new ConflictError(
    "policy-engine-capacity",
    `policy engine is full at ${String(capacity)} policy sets`,
    {
      retryable: false,
      metadata: { capacity },
    },
  );
}

/**
 * The gate rejected the operation outright.
 *
 * Not retryable: retrying the same input against the same policy set produces the same
 * decision, by construction. A caller that wants a different answer has to change the
 * request or the policy, and pretending otherwise would turn a denial into a retry storm.
 */
export function policyDenied(decision: PolicyDecision): PolicyViolationError {
  return new PolicyViolationError(
    decision.policyId,
    `policy denied ${decision.action.outcome === "deny" ? "action" : "action"}: ${reasonOf(decision)}`,
    {
      rule: decision.decidedByRuleId ?? undefined,
      requiresApproval: false,
      retryable: false,
      metadata: {
        policyName: decision.policyName,
        policyVersion: decision.policyVersion,
        decision: describePolicyDecision(decision),
      },
    },
  );
}

/** The gate requires a human approval before the operation may proceed. */
export function policyApprovalRequired(
  decision: PolicyDecision,
  requiredApprover: string,
): PolicyViolationError {
  return new PolicyViolationError(
    decision.policyId,
    `policy requires approval: ${reasonOf(decision)}`,
    {
      rule: decision.decidedByRuleId ?? undefined,
      requiresApproval: true,
      retryable: false,
      metadata: {
        policyName: decision.policyName,
        policyVersion: decision.policyVersion,
        requiredApprover,
        decision: describePolicyDecision(decision),
      },
    },
  );
}

/** An outcome that the engine does not know how to build a decision for. */
export function unsupportedPolicyOutcome(outcome: PolicyOutcome): ValidationError {
  return new ValidationError(`policy outcome "${outcome}" is not supported by this evaluator`, {
    retryable: false,
    metadata: { outcome },
  });
}

/** The human-readable half of a blocking decision. */
function reasonOf(decision: PolicyDecision): string {
  const action = decision.action;
  if (action.outcome === "deny" || action.outcome === "require_approval") {
    return action.reason;
  }
  return `${decision.policyName}@${String(decision.policyVersion)} returned ${action.outcome}`;
}
