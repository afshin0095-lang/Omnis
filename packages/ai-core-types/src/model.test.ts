import { describe, expect, it } from "vitest";
import { createModelId, createProviderId } from "@omnis/types";
import {
  DEFAULT_MODEL_PARAMETERS,
  MODEL_KINDS,
  compareModelDescriptors,
  describeModelReference,
  isModelCapability,
  isModelKind,
  isModelReference,
  isSelectableModelStatus,
  modelByCapability,
  modelById,
  modelBySlug,
  modelMatchesReference,
  modelSatisfiesCapabilities,
  modelSatisfiesModalities,
  type ModelDescriptor,
} from "./model.js";

function descriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: createModelId(),
    slug: "reasoning-large",
    displayName: "Reasoning Large",
    providerId: createProviderId(),
    kind: "reasoning",
    status: "available",
    capabilities: ["chat", "streaming", "tool_calling"],
    modalities: { input: ["text", "image"], output: ["text"] },
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    pricing: null,
    priority: 10,
    latencyClass: "medium",
    providerModelName: "vendor-reasoning-large",
    version: 1,
    metadata: {},
    registeredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("model references", () => {
  it("builds frozen references for each kind", () => {
    const modelId = createModelId();
    const providerId = createProviderId();

    const byId = modelById(modelId);
    expect(byId).toEqual({ kind: "id", modelId });
    expect(Object.isFrozen(byId)).toBe(true);

    const bySlug = modelBySlug("reasoning-large", providerId);
    expect(bySlug).toEqual({ kind: "slug", slug: "reasoning-large", providerId });

    const unscoped = modelBySlug("reasoning-large");
    expect(unscoped.kind === "slug" && unscoped.providerId).toBeNull();

    const byCapability = modelByCapability("tool_calling", { minContextWindowTokens: 32_000 });
    expect(byCapability).toEqual({
      kind: "capability",
      capability: "tool_calling",
      modelKind: null,
      providerId: null,
      minContextWindowTokens: 32_000,
      minMaxOutputTokens: 0,
    });
  });

  it("describes a reference without leaking anything but the reference", () => {
    const providerId = createProviderId();
    expect(describeModelReference(modelById(createModelId()))).toMatch(/^id:mdl_/);
    expect(describeModelReference(modelBySlug("fast"))).toBe("slug:fast");
    expect(describeModelReference(modelBySlug("fast", providerId))).toBe(`slug:fast@${providerId}`);
    expect(describeModelReference(modelByCapability("vision", { modelKind: "vision" }))).toBe(
      "capability:vision:vision",
    );
  });
});

describe("modelMatchesReference", () => {
  const modelId = createModelId();
  const providerId = createProviderId();
  const base = descriptor({ id: modelId, providerId, slug: "reasoning-large" });

  it("matches an exact identifier", () => {
    expect(modelMatchesReference(base, modelById(modelId))).toBe(true);
    expect(modelMatchesReference(base, modelById(createModelId()))).toBe(false);
  });

  it("matches a slug, optionally scoped to a provider", () => {
    expect(modelMatchesReference(base, modelBySlug("reasoning-large"))).toBe(true);
    expect(modelMatchesReference(base, modelBySlug("reasoning-large", providerId))).toBe(true);
    expect(modelMatchesReference(base, modelBySlug("reasoning-large", createProviderId()))).toBe(
      false,
    );
    expect(modelMatchesReference(base, modelBySlug("other"))).toBe(false);
  });

  it("matches a capability request including its minimums", () => {
    expect(modelMatchesReference(base, modelByCapability("tool_calling"))).toBe(true);
    expect(modelMatchesReference(base, modelByCapability("vision"))).toBe(false);
    expect(
      modelMatchesReference(base, modelByCapability("chat", { minContextWindowTokens: 200_000 })),
    ).toBe(false);
    expect(
      modelMatchesReference(base, modelByCapability("chat", { minContextWindowTokens: 128_000 })),
    ).toBe(true);
    expect(
      modelMatchesReference(base, modelByCapability("chat", { minMaxOutputTokens: 8_192 })),
    ).toBe(true);
    expect(modelMatchesReference(base, modelByCapability("chat", { modelKind: "fast" }))).toBe(
      false,
    );
    expect(modelMatchesReference(base, modelByCapability("chat", { modelKind: "reasoning" }))).toBe(
      true,
    );
  });

  it("never matches a retired model, whatever the reference", () => {
    const retired = descriptor({ id: modelId, status: "retired" });
    expect(modelMatchesReference(retired, modelById(modelId))).toBe(false);
    expect(isSelectableModelStatus("retired")).toBe(false);
    // Degraded stays selectable: removing a struggling model entirely would take the
    // only candidate out of service during exactly the outage that made it struggle.
    expect(isSelectableModelStatus("degraded")).toBe(true);
  });
});

describe("capability and modality matching", () => {
  it("requires every capability, not any of them", () => {
    const model = descriptor();
    expect(modelSatisfiesCapabilities(model, ["chat", "tool_calling"])).toBe(true);
    expect(modelSatisfiesCapabilities(model, ["chat", "structured_output"])).toBe(false);
    expect(modelSatisfiesCapabilities(model, [])).toBe(true);
  });

  it("checks input and output modalities separately", () => {
    const model = descriptor();
    expect(modelSatisfiesModalities(model, ["text", "image"], ["text"])).toBe(true);
    expect(modelSatisfiesModalities(model, ["audio"], ["text"])).toBe(false);
    expect(modelSatisfiesModalities(model, ["text"], ["audio"])).toBe(false);
  });

  it("recognizes only declared capabilities", () => {
    expect(isModelCapability("chat")).toBe(true);
    expect(isModelCapability("telepathy")).toBe(false);
  });
});

describe("compareModelDescriptors", () => {
  it("prefers the lower priority number", () => {
    const preferred = descriptor({ priority: 1, slug: "b" });
    const other = descriptor({ priority: 9, slug: "a" });
    expect(compareModelDescriptors(preferred, other)).toBeLessThan(0);
    expect(compareModelDescriptors(other, preferred)).toBeGreaterThan(0);
  });

  it("breaks a priority tie on capability breadth, then on slug", () => {
    const narrow = descriptor({ slug: "narrow", capabilities: ["chat"] });
    const broad = descriptor({ slug: "broad", capabilities: ["chat", "streaming"] });
    expect(compareModelDescriptors(broad, narrow)).toBeLessThan(0);

    const left = descriptor({ slug: "alpha", capabilities: ["chat"] });
    const right = descriptor({ slug: "beta", capabilities: ["chat"] });
    expect(compareModelDescriptors(left, right)).toBeLessThan(0);
    expect(compareModelDescriptors(right, left)).toBeGreaterThan(0);
  });

  it("is a total order: identical descriptors compare equal and sorting is stable across runs", () => {
    const same = descriptor({ id: createModelId() });
    expect(compareModelDescriptors(same, { ...same })).toBe(0);

    const models = [
      descriptor({ slug: "c", priority: 5 }),
      descriptor({ slug: "a", priority: 5 }),
      descriptor({ slug: "b", priority: 1 }),
    ];
    const first = [...models].sort(compareModelDescriptors).map((model) => model.slug);
    const second = [...models].sort(compareModelDescriptors).map((model) => model.slug);
    expect(first).toEqual(["b", "a", "c"]);
    expect(second).toEqual(first);
  });
});

describe("default parameters", () => {
  it("leaves every generation parameter unset", () => {
    expect(DEFAULT_MODEL_PARAMETERS).toEqual({
      temperature: null,
      topP: null,
      maxOutputTokens: null,
      stop: [],
      seed: null,
      responseFormat: null,
    });
    expect(Object.isFrozen(DEFAULT_MODEL_PARAMETERS)).toBe(true);
  });
});

describe("isModelReference", () => {
  it("accepts every variant the builders produce", () => {
    expect(isModelReference(modelById(createModelId()))).toBe(true);
    expect(isModelReference(modelBySlug("gpt-small"))).toBe(true);
    expect(isModelReference(modelBySlug("gpt-small", createProviderId()))).toBe(true);
    expect(isModelReference(modelByCapability("chat"))).toBe(true);
    expect(
      isModelReference(
        modelByCapability("structured_output", {
          modelKind: "reasoning",
          minContextWindowTokens: 8_000,
          minMaxOutputTokens: 1_000,
        }),
      ),
    ).toBe(true);
  });

  it("rejects a bare string, a wrong shape and an unknown capability", () => {
    expect(isModelReference("mdl_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isModelReference(null)).toBe(false);
    expect(isModelReference({ kind: "id" })).toBe(false);
    expect(isModelReference({ kind: "id", modelId: "" })).toBe(false);
    expect(isModelReference({ kind: "slug", slug: "" })).toBe(false);
    expect(
      isModelReference({
        kind: "capability",
        capability: "telepathy",
        modelKind: null,
        providerId: null,
        minContextWindowTokens: 0,
        minMaxOutputTokens: 0,
      }),
    ).toBe(false);
    expect(
      isModelReference({
        kind: "capability",
        capability: "chat",
        modelKind: "wizard",
        providerId: null,
        minContextWindowTokens: 0,
        minMaxOutputTokens: 0,
      }),
    ).toBe(false);
    expect(
      isModelReference({
        kind: "capability",
        capability: "chat",
        modelKind: null,
        providerId: null,
        minContextWindowTokens: -1,
        minMaxOutputTokens: 0,
      }),
    ).toBe(false);
    expect(isModelReference({ kind: "whatever" })).toBe(false);
  });

  it("knows the model kinds", () => {
    for (const kind of MODEL_KINDS) {
      expect(isModelKind(kind), kind).toBe(true);
    }
    expect(isModelKind("wizard")).toBe(false);
  });
});
