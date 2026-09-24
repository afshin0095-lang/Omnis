import type { ModelAdapter, ModelDescriptor, ModelInvocationResult, AiExecutionRequest } from "./types.js";
import { ModelRegistry } from "./registry.js";

export interface RoutedInvocation { model: ModelDescriptor; result: ModelInvocationResult; }

export class ModelOrchestrator {
  constructor(private readonly registry: ModelRegistry, private readonly adapters: Map<string, ModelAdapter>) {}

  select(request: AiExecutionRequest): ModelDescriptor {
    const candidates = this.registry.find(request.modelRequirements?.capabilities ?? []);
    const preferred = request.modelRequirements?.preferredModelIds ?? [];
    const ranked = [...candidates].sort((a, b) => {
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
    const model = this.select(request);
    const adapter = this.adapters.get(model.id);
    if (!adapter) throw new Error(`MODEL_ADAPTER_NOT_FOUND:${model.id}`);
    const result = await adapter.invoke({ executionId, model, input: request.input, signal });
    return { model, result };
  }
}
