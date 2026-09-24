import { randomUUID } from "node:crypto";
import type { AiExecutionRequest, AiExecutionResult, ModelAdapter, AiExecutionStatus } from "./types.js";
import { BudgetEngine } from "./budget.js";
import { assertDeadline, createExecutionContext } from "./context.js";
import { EvaluationEngine } from "./evaluation.js";
import { EventLog } from "./events.js";
import { ModelOrchestrator } from "./orchestrator.js";
import { PolicyEngine } from "./policy.js";
import { ModelRegistry } from "./registry.js";
import { InMemoryApprovalGate, type ApprovalGate } from "./approval.js";
import { InMemoryExecutionStore, type ExecutionStore } from "./durable.js";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.js";

export class ExecutionKernel {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly adapters: Map<string, ModelAdapter>,
    private readonly policies = new PolicyEngine(),
    private readonly budgets = new BudgetEngine(),
    private readonly evaluations = new EvaluationEngine(),
    private readonly events = new EventLog(),
    private readonly approvals: ApprovalGate = new InMemoryApprovalGate(),
    private readonly store: ExecutionStore = new InMemoryExecutionStore(),
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  async execute(request: AiExecutionRequest): Promise<AiExecutionResult> {
    const existing = request.idempotencyKey
      ? await this.store.findByIdempotencyKey(request.tenantId, request.idempotencyKey)
      : undefined;
    if (existing?.result) return existing.result;

    const executionId = existing?.executionId ?? randomUUID();
    const controller = new AbortController();
    const ctx = createExecutionContext(request, executionId, controller);
    let state: AiExecutionStatus = "created";
    const persist = async (result?: AiExecutionResult) => {
      await this.store.save({ executionId, request, result, state, idempotencyKey: request.idempotencyKey, updatedAt: new Date().toISOString() });
    };
    const emit = async (type: string, payload: Record<string, unknown> = {}) => {
      this.events.append({
        type, version: 1, eventId: randomUUID(), executionId, requestId: request.requestId,
        correlationId: ctx.correlationId, occurredAt: new Date().toISOString(), payload,
      });
    };
    const setState = async (next: AiExecutionStatus) => { state = next; await persist(); };

    try {
      await persist();
      await emit("ai.execution.created");
      assertDeadline(ctx);
      await setState("validated");
      await emit("ai.execution.validated");

      const decision = this.policies.evaluate(request);
      if (!decision.allowed) throw new Error("POLICY_DENIED:" + decision.reasonCodes.join(","));
      await setState("authorized");
      await emit("ai.execution.authorized", { policyIds: decision.policyIds });

      if (this.approvals.requiresApproval(request)) {
        const approval = this.approvals.createRequest(executionId, request);
        state = "awaiting_approval";
        const result: AiExecutionResult = {
          executionId, requestId: request.requestId, status: "awaiting_approval", approvalRequestId: approval.id,
        };
        await persist(result);
        await emit("ai.execution.awaiting_approval", { approvalRequestId: approval.id });
        return result;
      }

      if (request.budget) {
        this.budgets.reserve(executionId, request.budget);
        await setState("reserved");
        await emit("ai.execution.reserved");
      }
      const orchestrator = new ModelOrchestrator(this.registry, this.adapters, this.retryPolicy);
      await setState("planned");
      await emit("ai.execution.planned");
      const routed = await orchestrator.invoke(executionId, request, ctx.signal);
      await setState("executing");
      await emit("ai.execution.executing", { modelId: routed.model.id, providerId: routed.model.providerId, attempts: routed.attempts });

      const resultBase: AiExecutionResult = {
        executionId, requestId: request.requestId, status: "completed",
        output: routed.result.output, modelId: routed.model.id, providerId: routed.model.providerId,
        usage: { inputTokens: routed.result.inputTokens, outputTokens: routed.result.outputTokens,
          estimatedCost: routed.result.estimatedCost, latencyMs: Date.now() - Date.parse(ctx.startedAt) },
      };
      await setState("settling");
      await emit("ai.execution.settling", { estimatedCost: resultBase.usage?.estimatedCost ?? 0 });
      if (request.budget) this.budgets.settle(executionId, resultBase.usage?.estimatedCost ?? 0);
      await setState("evaluating");
      await emit("ai.execution.evaluating");
      const evaluation = this.evaluations.evaluate(resultBase);
      const result = { ...resultBase, evaluation };
      state = "completed";
      await persist(result);
      await emit("ai.execution.completed", { score: evaluation.score, passed: evaluation.passed });
      return result;
    } catch (error) {
      if (request.budget) {
        try { this.budgets.release(executionId); } catch { /* already settled */ }
      }
      const message = error instanceof Error ? error.message : String(error);
      const result: AiExecutionResult = {
        executionId, requestId: request.requestId, status: "failed",
        failure: { code: message.split(":")[0] ?? "EXECUTION_FAILED", message, retryable: false },
      };
      state = "failed";
      await persist(result);
      await emit("ai.execution.failed", { message });
      return result;
    }
  }

  getEvents(): EventLog { return this.events; }
  async getExecution(executionId: string) { return this.store.get(executionId); }
}
