import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, ExecutionKernel, ModelRegistry, PolicyEngine, withRetry } from "../dist/index.js";

const adapter = {
  async invoke({ model }) {
    return { output: { model: model.id }, inputTokens: 1, outputTokens: 1, estimatedCost: 0.01 };
  }
};

function kernel() {
  const registry = new ModelRegistry();
  registry.register({
    id: "model.v1", providerId: "provider", version: "1",
    capabilities: ["text-generation"], qualityScore: .8,
    costPer1kTokens: .1, averageLatencyMs: 10, enabled: true
  });
  return new ExecutionKernel(registry, new Map([["model.v1", adapter]]), new PolicyEngine());
}

test("agent runtime resolves registered agent into an AI execution", async () => {
  const runtime = new AgentRuntime(new Map(), kernel());
  runtime.register({ id: "script-writer", version: "1", capabilities: ["text-generation"], systemInstruction: "write" });
  const result = await runtime.run({
    agentId: "script-writer", tenantId: "t1", taskType: "script.generate",
    input: { topic: "future" }, modelCapabilities: ["text-generation"]
  });
  assert.equal(result.status, "completed");
  assert.equal(result.modelId, "model.v1");
});

test("retry stops after the configured attempts", async () => {
  let attempts = 0;
  await assert.rejects(() => withRetry(async () => {
    attempts++;
    throw new Error("TRANSIENT");
  }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 }));
  assert.equal(attempts, 2);
});
