import type { AiExecutionRequest, ModelAdapter, ModelDescriptor } from "./types.js";
import { ModelRegistry } from "./registry.js";

export interface FallbackCandidate {
  model: ModelDescriptor;
  adapter: ModelAdapter;
}

export class FallbackRouter {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly adapters: Map<string, ModelAdapter>,
  ) {}

  candidates(request: AiExecutionRequest): FallbackCandidate[] {
    return this.registry
      .find(request.modelRequirements?.capabilities ?? [])
      .sort((a, b) => b.qualityScore - a.qualityScore)
      .map(model => {
        const adapter = this.adapters.get(model.id);
        return adapter ? { model, adapter } : undefined;
      })
      .filter((x): x is FallbackCandidate => Boolean(x));
  }
}
