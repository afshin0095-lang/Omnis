import type { AiExecutionResult, EvaluationResult } from "./types.js";

export interface EvaluationRule {
  id: string;
  version: string;
  evaluate(result: AiExecutionResult): EvaluationResult;
}

export class EvaluationEngine {
  constructor(private readonly rules: EvaluationRule[] = []) {}

  evaluate(result: AiExecutionResult): EvaluationResult {
    if (this.rules.length === 0) {
      return { ruleSetId: "core.default", ruleSetVersion: "1", score: 1, passed: true, evidence: ["NO_RULES"] };
    }
    const evaluations = this.rules.map(r => r.evaluate(result));
    const score = evaluations.reduce((sum, e) => sum + e.score, 0) / evaluations.length;
    return {
      ruleSetId: evaluations.map(e => e.ruleSetId).join("+"),
      ruleSetVersion: evaluations.map(e => e.ruleSetVersion).join("+"),
      score,
      passed: evaluations.every(e => e.passed),
      evidence: evaluations.flatMap(e => e.evidence),
    };
  }
}
