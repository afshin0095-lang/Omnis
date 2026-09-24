import type { ModelDescriptor } from "./types.js";
import { ModelRegistry } from "./registry.js";

export interface CapabilityAssessment {
  modelId: string;
  capability: string;
  score: number;
  measuredAt: string;
  benchmarkId: string;
}

export interface ModelBenchmark {
  id: string;
  capability: string;
  run(model: ModelDescriptor): Promise<number>;
}

export class ModelEvolutionService {
  constructor(private readonly registry: ModelRegistry) {}

  discover(capabilities: string[]): ModelDescriptor[] {
    return this.registry.find(capabilities).sort(
      (a, b) => b.qualityScore - a.qualityScore || a.costPer1kTokens - b.costPer1kTokens,
    );
  }

  async benchmark(model: ModelDescriptor, benchmark: ModelBenchmark): Promise<CapabilityAssessment> {
    const score = await benchmark.run(model);
    return {
      modelId: model.id,
      capability: benchmark.capability,
      score,
      measuredAt: new Date().toISOString(),
      benchmarkId: benchmark.id,
    };
  }

  applyAssessment(assessment: CapabilityAssessment): ModelDescriptor {
    const model = this.registry.get(assessment.modelId);
    if (!model) throw new Error("MODEL_NOT_FOUND");
    const updated = {
      ...model,
      qualityScore: Math.max(0, Math.min(1, assessment.score)),
      metadata: {
        ...model.metadata,
        [`benchmark.${assessment.capability}`]: assessment.score.toFixed(4),
        "benchmark.lastRun": assessment.measuredAt,
      },
    };
    this.registry.upsert(updated);
    return updated;
  }
}
