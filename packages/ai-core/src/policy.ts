import type { AiExecutionRequest, PolicyDecision } from "./types.js";

export interface PolicyRule {
  id: string;
  evaluate(request: AiExecutionRequest): PolicyDecision | null;
}

export class PolicyEngine {
  constructor(private readonly rules: PolicyRule[] = []) {}

  evaluate(request: AiExecutionRequest): PolicyDecision {
    const decisions = this.rules.map(rule => rule.evaluate(request)).filter((x): x is PolicyDecision => x !== null);
    const denied = decisions.find(d => !d.allowed);
    if (denied) return denied;
    return {
      allowed: true,
      reasonCodes: decisions.flatMap(d => d.reasonCodes),
      policyIds: decisions.flatMap(d => d.policyIds),
    };
  }
}

export const denyTaskTypes = (taskTypes: string[]): PolicyRule => ({
  id: "core.task-type-denylist.v1",
  evaluate: request => taskTypes.includes(request.taskType)
    ? { allowed: false, reasonCodes: ["TASK_TYPE_DENIED"], policyIds: ["core.task-type-denylist.v1"] }
    : null,
});
