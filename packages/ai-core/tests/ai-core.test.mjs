import test from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry, ExecutionKernel, PolicyEngine, denyTaskTypes } from "../dist/index.js";

const adapter = {
  async invoke() {
    return { output: { text: "ok" }, inputTokens: 10, outputTokens: 5, estimatedCost: 0.01 };
  }
};

test("routes a request to a capable model and completes the lifecycle", async () => {
  const registry = new ModelRegistry();
  registry.register({
    id: "test.model.v1", providerId: "test", version: "1",
    capabilities: ["text-generation"], qualityScore: 0.9,
    costPer1kTokens: 0.1, averageLatencyMs: 20, enabled: true
  });
  const kernel = new ExecutionKernel(registry, new Map([["test.model.v1", adapter]]));
  const result = await kernel.execute({
    requestId: "req-1", tenantId: "tenant-1", taskType: "script.generate",
    input: { topic: "OMNIS" }, modelRequirements: { capabilities: ["text-generation"] },
    budget: { currency: "USD", maxAmount: 1 }
  });
  assert.equal(result.status, "completed");
  assert.equal(result.modelId, "test.model.v1");
  assert.equal(result.evaluation?.passed, true);
  assert.ok(kernel.getEvents().list().some(e => e.type === "ai.execution.completed"));
});

test("denies policy-sensitive task types before model execution", async () => {
  const registry = new ModelRegistry();
  registry.register({
    id: "test.model.v1", providerId: "test", version: "1",
    capabilities: ["text-generation"], qualityScore: 0.9,
    costPer1kTokens: 0.1, averageLatencyMs: 20, enabled: true
  });
  const policy = new PolicyEngine([denyTaskTypes(["blocked.task"])]);
  const kernel = new ExecutionKernel(registry, new Map([["test.model.v1", adapter]]), policy);
  const result = await kernel.execute({
    requestId: "req-2", tenantId: "tenant-1", taskType: "blocked.task", input: null,
    modelRequirements: { capabilities: ["text-generation"] }
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "POLICY_DENIED");
});
