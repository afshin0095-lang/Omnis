import test from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionKernel,
  InMemoryApprovalGate,
  InMemoryExecutionStore,
  ModelRegistry,
} from "../dist/index.js";

function registry() {
  const r = new ModelRegistry();
  r.register({
    id: "model.primary", providerId: "provider", version: "1",
    capabilities: ["text-generation"], qualityScore: .95,
    costPer1kTokens: .1, averageLatencyMs: 20, enabled: true
  });
  r.register({
    id: "model.fallback", providerId: "provider", version: "1",
    capabilities: ["text-generation"], qualityScore: .8,
    costPer1kTokens: .2, averageLatencyMs: 30, enabled: true
  });
  return r;
}

test("idempotency returns the persisted completed result", async () => {
  let calls = 0;
  const adapter = { async invoke({ model }) {
    calls++;
    return { output: { model: model.id, calls }, inputTokens: 1, outputTokens: 1, estimatedCost: .01 };
  }};
  const store = new InMemoryExecutionStore();
  const kernel = new ExecutionKernel(registry(), new Map([["model.primary", adapter]]), undefined, undefined, undefined, undefined, undefined, store);
  const request = {
    requestId: "idem-1", tenantId: "tenant", taskType: "script.generate", idempotencyKey: "same-key",
    input: { topic: "OMNIS" }, modelRequirements: { capabilities: ["text-generation"] }
  };
  const first = await kernel.execute(request);
  const second = await kernel.execute({ ...request, requestId: "idem-2" });
  assert.equal(first.status, "completed");
  assert.equal(second.executionId, first.executionId);
  assert.equal(calls, 1);
});

test("approval gate stops protected execution before model invocation", async () => {
  let calls = 0;
  const adapter = { async invoke() { calls++; throw new Error("MUST_NOT_RUN"); } };
  const approvals = new InMemoryApprovalGate(new Set(["publish"]));
  const kernel = new ExecutionKernel(registry(), new Map([["model.primary", adapter]]), undefined, undefined, undefined, undefined, approvals);
  const result = await kernel.execute({
    requestId: "approval-1", tenantId: "tenant", taskType: "publish", input: {},
    modelRequirements: { capabilities: ["text-generation"] }
  });
  assert.equal(result.status, "awaiting_approval");
  assert.ok(result.approvalRequestId);
  assert.equal(calls, 0);
});

test("fallback routes to a second model after primary failure", async () => {
  const primary = { async invoke() { throw new Error("TRANSIENT_PRIMARY"); } };
  const fallback = { async invoke({ model }) {
    return { output: { model: model.id }, inputTokens: 1, outputTokens: 1, estimatedCost: .02 };
  }};
  const kernel = new ExecutionKernel(registry(), new Map([
    ["model.primary", primary], ["model.fallback", fallback]
  ]), undefined, undefined, undefined, undefined, undefined, undefined, {
    maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1
  });
  const result = await kernel.execute({
    requestId: "fallback-1", tenantId: "tenant", taskType: "script.generate", input: {},
    modelRequirements: { capabilities: ["text-generation"] }
  });
  assert.equal(result.status, "completed");
  assert.equal(result.modelId, "model.fallback");
});

test("maxCost and maxLatency are enforced during routing", async () => {
  const adapter = { async invoke({ model }) {
    return { output: model.id, inputTokens: 1, outputTokens: 1, estimatedCost: .01 };
  }};
  const kernel = new ExecutionKernel(registry(), new Map([
    ["model.primary", adapter], ["model.fallback", adapter]
  ]));
  const result = await kernel.execute({
    requestId: "limits-1", tenantId: "tenant", taskType: "script.generate", input: {},
    modelRequirements: { capabilities: ["text-generation"], maxCost: .15, maxLatencyMs: 25 }
  });
  assert.equal(result.status, "completed");
  assert.equal(result.modelId, "model.primary");
});
