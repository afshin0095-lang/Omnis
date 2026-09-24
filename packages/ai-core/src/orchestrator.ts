import type { ModelAdapter, ModelDescriptor, ModelInvocationResult, AiExecutionRequest } from "./types.js";
import { ModelRegistry } from "./registry.js";
import { FallbackRouter } from "./fallback.js";
import { withRetry, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.js";

export interface RoutedInvocation { model: ModelDescriptor; result: ModelInvocationResult; attempts: number; }

export class ModelOrchestrator {
  private readonly fallback: FallbackRouter;
  constructor(
    private readonly registry: ModelRegistry,
    private readonly adapters: Map<string, ModelAdapter>,
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {
    this.fallback = new FallbackRouter(registry, adapters);
  }

  select(request: AiExecutionRequest): ModelDescriptor {
    const candidates = this.registry.find(request.modelRequirements?.capabilities ?? []);
    const preferred = request.modelRequirements?.preferredModelIds ?? [];
    const maxCost = request.modelRequirements?.maxCost;
    const ranked = [...candidates]
      .filter(model => maxCost === undefined || model.costPer1kTokens <= maxCost)
      .sort((a, b) => {
        const ap = preferred.includes(a.id) ? 1 : 0;
        const bp = preferred.includes(b.id) ? 1 : 0;
        return (bp - ap) || (b.qualityScore - a.qualityScore) || (a.costPer1kTokens - b.costPer1kTokens);
      });
    const selected = ranked[0];
    if (!selected) throw new Error("NO_MODEL_CAPABLE_OF_REQUEST");
    if (request.modelRequirements?.maxLatencyMs && selected.averageLatencyMs > request.modelRequirements.maxLatencyMs) {
      throw new Error("NO_MODEL_WITHIN_LATENCY_LIMIT");
    }
    return selected;
  }

  async invoke(executionId: string, request: AiExecutionRequest, signal: AbortSignal): Promise<RoutedInvocation> {
    const candidates = this.fallback.candidates(request)
      .filter(candidate => request.modelRequirements?.maxCost === undefined ||
        candidate.model.costPer1kTokens <= request.modelRequirements.maxCost)
      .filter(candidate => !request.modelRequirements?.maxLatencyMs ||
        candidate.model.averageLatencyMs <= request.modelRequirements.maxLatencyMs);
    const preferred = request.modelRequirements?.preferredModelIds ?? [];
    candidates.sort((a, b) => {
      const ap = preferred.includes(a.model.id) ? 1 : 0;
      const bp = preferred.includes(b.model.id) ? 1 : 0;
      return (bp - ap) || (b.model.qualityScore - a.model.qualityScore) ||
        (a.model.costPer1kTokens - b.model.costPer1kTokens);
    });
    if (!candidates.length) throw new Error("NO_MODEL_CAPABLE_OF_REQUEST");

    let lastError: unknown;
    let attempts = 0;
    for (const candidate of candidates) {
      try {
        const result = await withRetry(async () => {
          attempts++;
          return candidate.adapter.invoke({ executionId, model: candidate.model, input: request.input, signal });
        }, this.retryPolicy);
        return { model: candidate.model, result, attempts };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("MODEL_EXECUTION_FAILED");
  }
}
