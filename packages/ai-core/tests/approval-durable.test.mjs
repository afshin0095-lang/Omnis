import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryApprovalGate, InMemoryExecutionStore } from "../dist/index.js";

test("approval gate identifies protected task types", () => {
  const gate = new InMemoryApprovalGate(new Set(["publish.youtube"]));
  assert.equal(gate.requiresApproval({ taskType: "publish.youtube" }), true);
  assert.equal(gate.requiresApproval({ taskType: "script.generate" }), false);
});

test("execution store persists and retrieves state", async () => {
  const store = new InMemoryExecutionStore();
  await store.save({
    executionId: "ex-1",
    request: { requestId: "r1", tenantId: "t1", taskType: "x", input: null },
    state: "executing",
    updatedAt: ""
  });
  const record = await store.get("ex-1");
  assert.equal(record?.state, "executing");
});
