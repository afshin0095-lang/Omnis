/**
 * The agent registry: immutable descriptors, deterministic lookup, fail-closed status.
 */

import { describe, expect, it } from "vitest";
import {
  createAgentId,
  createBudgetId,
  createModelId,
  createPolicyId,
  createToolId,
} from "@omnis/types";
import {
  agentById,
  agentBySlug,
  modelByCapability,
  modelBySlug,
  UNCONSTRAINED_AGENT,
} from "@omnis/ai-core-types";
import type { AgentDescriptor, ModelReference } from "@omnis/ai-core-types";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import { createAgentRegistry, describeAgentResolution, preferredModelOf } from "./AgentRegistry.js";
import type { AgentRegistrationInput } from "./agentValidation.js";
import { testClock, AT } from "./testSupport.js";

function registry() {
  return createAgentRegistry({ clock: () => Date.parse(AT) });
}

function registered(overrides: Partial<AgentRegistrationInput> = {}) {
  const store = registry();
  const descriptor = store.register({
    slug: "assistant",
    kind: "reactive",
    status: "active",
    ...overrides,
  });
  return { store, descriptor };
}

describe("registration", () => {
  it("returns a descriptor carrying every fact it was given", () => {
    const policyId = createPolicyId();
    const budgetId = createBudgetId();
    const { descriptor } = registered({
      displayName: "Brief assistant",
      description: "Summarises briefs.",
      kind: "planner",
      status: "active",
      version: "2.1.0",
      capabilities: ["planning", "tool_use"],
      instructions: {
        system: "Answer briefly.",
        developer: "Never invent a citation.",
        prohibitions: ["no medical advice"],
      },
      policyId,
      budgetId,
      metadata: { team: "growth" },
    });

    expect(descriptor.slug).toBe("assistant");
    expect(descriptor.displayName).toBe("Brief assistant");
    expect(descriptor.kind).toBe("planner");
    expect(descriptor.version).toBe("2.1.0");
    expect(descriptor.capabilities).toEqual(["planning", "tool_use"]);
    expect(descriptor.instructions.system).toBe("Answer briefly.");
    expect(descriptor.instructions.developer).toBe("Never invent a citation.");
    expect(descriptor.instructions.prohibitions).toEqual(["no medical advice"]);
    expect(descriptor.policyId).toBe(policyId);
    expect(descriptor.budgetId).toBe(budgetId);
    expect(descriptor.metadata).toEqual({ team: "growth" });
    expect(descriptor.createdAt).toBe(AT);
  });

  it("defaults a registration that said nothing about status to draft, which cannot run", () => {
    const { descriptor } = registered({ status: undefined });
    expect(descriptor.status).toBe("draft");
  });

  it("defaults the display name to the slug and the ceilings to unconstrained", () => {
    const { descriptor } = registered();
    expect(descriptor.displayName).toBe("assistant");
    expect(descriptor.description).toBe("");
    expect(descriptor.version).toBe("1.0.0");
    expect(descriptor.constraints).toEqual(UNCONSTRAINED_AGENT);
    expect(descriptor.defaultModel).toBeNull();
    expect(descriptor.tools).toEqual([]);
    expect(descriptor.memory).toEqual([]);
  });

  it("freezes the descriptor and everything inside it", () => {
    const toolId = createToolId();
    const { descriptor } = registered({
      tools: [{ toolId, maxCallsPerExecution: 3, required: true }],
      memory: [{ kind: "short_term", storeId: "store-1", writable: true }],
      constraints: {
        maxSteps: 4,
        allowedTools: [toolId],
        preferredModels: [{ kind: "id", modelId: createModelId() }],
      },
      metadata: { team: "growth" },
    });

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.instructions)).toBe(true);
    expect(Object.isFrozen(descriptor.instructions.prohibitions)).toBe(true);
    expect(Object.isFrozen(descriptor.tools[0])).toBe(true);
    expect(Object.isFrozen(descriptor.memory[0])).toBe(true);
    expect(Object.isFrozen(descriptor.constraints)).toBe(true);
    expect(Object.isFrozen(descriptor.constraints.allowedTools)).toBe(true);
    expect(Object.isFrozen(descriptor.constraints.preferredModels[0])).toBe(true);
    expect(Object.isFrozen(descriptor.metadata)).toBe(true);
  });

  it("refuses a second agent with the same slug", () => {
    const store = registry();
    store.register({ slug: "assistant", kind: "reactive" });
    let caught: unknown = null;
    try {
      store.register({ slug: "assistant", kind: "planner" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).message).toContain("assistant");
  });

  it("refuses a second agent with the same identifier", () => {
    const id = createAgentId();
    const store = registry();
    store.register({ id, slug: "assistant", kind: "reactive" });
    expect(() => store.register({ id, slug: "other", kind: "reactive" })).toThrow(ConflictError);
  });

  it("refuses a malformed registration rather than storing a half descriptor", () => {
    const store = registry();
    expect(() =>
      store.register({ slug: "assistant", kind: "reactive", constraints: { maxSteps: -1 } }),
    ).toThrow(ValidationError);
    expect(() =>
      store.register({ slug: "assistant", kind: "reactive", version: "not-a-version" }),
    ).toThrow(ValidationError);
    expect(() =>
      store.register({ slug: "assistant", kind: "reactive", unknownField: true } as never),
    ).toThrow(ValidationError);
    expect(store.size).toBe(0);
  });

  it("refuses a descriptor that binds the same tool twice", () => {
    const toolId = createToolId();
    const store = registry();
    expect(() =>
      store.register({ slug: "assistant", kind: "reactive", tools: [{ toolId }, { toolId }] }),
    ).toThrow(RangeError);
  });

  it("redacts a secret-looking metadata value instead of storing it", () => {
    const { descriptor } = registered({
      metadata: { apiKey: "sk-live-1234567890", team: "growth" }, // omnis-secret-scan:allow a deliberate fake, used to prove this value is redacted
    });
    expect(descriptor.metadata["team"]).toBe("growth");
    expect(String(descriptor.metadata["apiKey"])).not.toContain("sk-live-1234567890");
  });

  it("keeps a model preference a preference, and reports the first one", () => {
    const first: ModelReference = modelBySlug("fast-model");
    const { descriptor } = registered({
      defaultModel: { kind: "id", modelId: createModelId() },
      constraints: { preferredModels: [first] },
    });
    expect(preferredModelOf(descriptor)).toEqual(first);
  });

  it("falls back to the default model when no preference is declared", () => {
    const fallback: ModelReference = modelByCapability("chat");
    const { descriptor } = registered({ defaultModel: fallback });
    expect(preferredModelOf(descriptor)).toEqual(fallback);
    expect(preferredModelOf(registered().descriptor)).toBeNull();
  });
});

describe("lookup", () => {
  it("finds an agent by identifier and by slug", () => {
    const store = registry();
    const descriptor = store.register({ slug: "assistant", kind: "reactive" });
    expect(store.get(descriptor.id)).toBe(descriptor);
    expect(store.getBySlug("assistant")).toBe(descriptor);
    expect(store.idForSlug("assistant")).toBe(descriptor.id);
    expect(store.has(descriptor.id)).toBe(true);
    expect(store.hasSlug("assistant")).toBe(true);
  });

  it("returns null for what it does not hold, and throws only when asked to require", () => {
    const store = registry();
    const missing = createAgentId();
    expect(store.get(missing)).toBeNull();
    expect(store.getBySlug("nobody")).toBeNull();
    expect(store.idForSlug("nobody")).toBeNull();
    expect(() => store.require(missing)).toThrow(NotFoundError);
    expect(() => store.requireResolution(agentBySlug("nobody"))).toThrow(NotFoundError);
  });

  it("lists agents in a deterministic order that does not depend on registration order", () => {
    const first = registry();
    first.register({ slug: "zulu", kind: "reactive" });
    first.register({ slug: "alpha", kind: "reactive" });
    first.register({ slug: "mike", kind: "reactive" });

    const second = registry();
    second.register({ slug: "mike", kind: "reactive" });
    second.register({ slug: "zulu", kind: "reactive" });
    second.register({ slug: "alpha", kind: "reactive" });

    expect(first.list().map((descriptor) => descriptor.slug)).toEqual(["alpha", "mike", "zulu"]);
    expect(second.list().map((descriptor) => descriptor.slug)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("filters by kind, capability and status", () => {
    const store = registry();
    store.register({
      slug: "planner",
      kind: "planner",
      capabilities: ["planning"],
      status: "active",
    });
    store.register({ slug: "worker", kind: "worker", capabilities: ["tool_use"], status: "draft" });
    store.register({
      slug: "router",
      kind: "router",
      capabilities: ["planning", "tool_use"],
      status: "disabled",
    });

    expect(store.findByKind("planner").map((descriptor) => descriptor.slug)).toEqual(["planner"]);
    expect(store.findByCapability("planning").map((descriptor) => descriptor.slug)).toEqual([
      "planner",
      "router",
    ]);
    expect(store.findByStatus("draft").map((descriptor) => descriptor.slug)).toEqual(["worker"]);
    expect(store.executable().map((descriptor) => descriptor.slug)).toEqual(["planner"]);
  });

  it("resolves a reference and says how it matched", () => {
    const store = registry();
    const descriptor = store.register({ slug: "assistant", kind: "reactive" });

    const byId = store.resolve(agentById(descriptor.id));
    expect(byId?.matchedBy).toBe("id");
    expect(byId?.descriptor).toBe(descriptor);
    expect(byId?.candidates).toEqual([descriptor]);

    const bySlug = store.resolve(agentBySlug("assistant"));
    expect(bySlug?.matchedBy).toBe("slug");
    expect(store.resolve(agentBySlug("nobody"))).toBeNull();
    expect(bySlug === null ? "" : describeAgentResolution(bySlug)).toBe(
      "slug:assistant -> assistant@1.0.0",
    );
  });
});

describe("removal and status", () => {
  it("removes an agent and stops resolving its slug", () => {
    const store = registry();
    const descriptor = store.register({ slug: "assistant", kind: "reactive" });
    expect(store.remove(descriptor.id)).toBe(true);
    expect(store.remove(descriptor.id)).toBe(false);
    expect(store.size).toBe(0);
    expect(store.getBySlug("assistant")).toBeNull();
  });

  it("lets a slug be re-registered after removal, and does not let a late removal un-index it", () => {
    const store = registry();
    const old = store.register({ slug: "assistant", kind: "reactive" });
    expect(store.remove(old.id)).toBe(true);
    const fresh = store.register({ slug: "assistant", kind: "planner" });
    expect(store.getBySlug("assistant")).toBe(fresh);
    // Removing the descriptor that is already gone must not drop the new one's index.
    expect(store.remove(old.id)).toBe(false);
    expect(store.getBySlug("assistant")).toBe(fresh);
  });

  it("moves a status along the legal lifecycle and bumps updatedAt", () => {
    const clock = testClock();
    const store = createAgentRegistry({ clock: () => clock() });
    const descriptor = store.register({ slug: "assistant", kind: "reactive" });
    expect(descriptor.status).toBe("draft");

    clock.advance(1_000);
    const activated = store.setStatus(descriptor.id, "active");
    expect(activated.status).toBe("active");
    expect(activated.updatedAt).not.toBe(descriptor.updatedAt);
    expect(store.executable()).toEqual([activated]);
  });

  it("refuses to un-retire an agent", () => {
    const store = registry();
    const descriptor = store.register({ slug: "assistant", kind: "reactive", status: "active" });
    expect(store.setStatus(descriptor.id, "retired").status).toBe("retired");
    expect(() => store.setStatus(descriptor.id, "active")).toThrow(ConflictError);
  });

  it("keeps the old descriptor usable after a status change, because it is immutable", () => {
    const store = registry();
    const descriptor: AgentDescriptor = store.register({
      slug: "assistant",
      kind: "reactive",
      status: "active",
    });
    store.setStatus(descriptor.id, "disabled");
    expect(descriptor.status).toBe("active");
    expect(store.require(descriptor.id).status).toBe("disabled");
  });
});
