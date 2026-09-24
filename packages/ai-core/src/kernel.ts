import { randomUUID } from "node:crypto";
import type { AiExecutionRequest, AiExecutionResult, ModelAdapter } from "./types.js";
import { BudgetEngine } from "./budget.js";
import { assertDeadline, createExecutionContext } from "./context.js";
import { EvaluationEngine } from "./evaluation.js";
import { EventLog } from "./events.js";
import { ModelOrchestrator } from "./orchestrator.js";
import { PolicyEngine } from "./policy.js";
import { ModelRegistry } from "./registry.js";

export class ExecutionKernel {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly adapters: Map<string, ModelAdapter>,
    private readonly policies = new PolicyEngine(),
    private readonly budgets = new BudgetEngine(),
    private readonly evaluations = new EvaluationEngine(),
    private readonly events = new EventLog(),
  ) {}

  async execute(request: AiExecutionRequest): Promise<AiExecutionResult> {
    const executionId = randomUUID();
    const controller = new AbortController();
    const ctx = createExecutionContext(request, executionId, controller);
    const emit = (type: string, payload: Record<string, unknown> = {}) => this.events.append({
      type, version: 1, eventId: randomUUID(), executionId, requestId: request.requestId,
      correlationId: ctx.correlationId, occurredAt: new Date().toISOString(), payload,
    });

    try {
      emit("ai.execution.created");
      assertDeadline(ctx);
      emit("ai.execution.validated");
      const decision = this.policies.evaluate(request);
      if (!decision.allowed) throw new Error(`POLICY_DENIED:${decision.reasonCodes.join(",")}`);
      emit("ai.execution.authorized", { policyIds: decision.policyIds });

      if (request.budget) this.budgets.reserve(executionId, request.budget);
      emit("ai.execution.reserved");

      const orchestrator = new ModelOrchestrator(this.registry, this.adapters);
      emit("ai.execution.planned");
      const routed = await orchestrator.invoke(executionId, request, ctx.signal);
      emit("ai.execution.executing", { modelId: routed.model.id, providerId: routed.model.providerId });

      const base: AiExecutionResult = {
        executionId, requestId: request.requestId, status: "completed",
        output: routed.result.output, modelId: routed.model.id, providerId: routed.model.providerId,
        usage: { inputTokens: routed.result.inputTokens, outputTokens: routed.result.outputTokens,
          estimatedCost: routed.result.estimatedCost, latencyMs: Date.now() - Date.parse(ctx.startedAt) },
      };
      emit("ai.execution.settling", { estimatedCost: base.usage?.estimatedCost ?? 0 });
      if (request.budget) this.budgets.settle(executionId, base.usage?.estimatedCost ?? 0);
      emit("ai.execution.evaluating");
      const evaluation = this.evaluations.evaluate(base);
      const result = { ...base, evaluation };
      emit("ai.execution.completed", { score: evaluation.score, passed: evaluation.passed });
      return result;
    } catch (error) {
      if (request.budget) {
        try { this.budgets.release(executionId); } catch { /* no-op after settlement */ }
      }
      const message = error instanceof Error ? error.message : String(error);
      emit("ai.execution.failed", { message });
      return { executionId, requestId: request.requestId, status: "failed",
        failure: { code: message.split(":")[0] ?? "EXECUTION_FAILED", message, retryable: false } };
    }
  }

  getEvents(): EventLog { return this.events; }
}
