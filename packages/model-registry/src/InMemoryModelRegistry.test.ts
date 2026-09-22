import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import { createModelId, createProviderId } from "@omnis/types";
import {
  modelByCapability,
  modelById,
  modelBySlug,
  isSelectableModelStatus,
} from "@omnis/ai-core-types";
import { InMemoryModelRegistry } from "./InMemoryModelRegistry.js";
import { isLegalModelStatusTransition, MODEL_STATUS_TRANSITIONS } from "./ModelRegistry.js";
import type { ModelRegistrationInput } from "./modelValidation.js";

const FIXED_TIME = "2026-03-01T12:00:00.000Z";

function registry() {
  return new InMemoryModelRegistry({ clock: () => FIXED_TIME });
}

function input(overrides: Partial<ModelRegistrationInput> = {}): ModelRegistrationInput {
  return {
    slug: "reasoning-large",
    displayName: "Reasoning Large",
    providerId: createProviderId(),
    kind: "reasoning",
    capabilities: ["chat", "streaming", "tool_calling"],
    modalities: { input: ["text"], output: ["text"] },
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    providerModelName: "vendor-reasoning-large",
    ...overrides,
  };
}

describe("registration", () => {
  it("assigns an identifier, version and timestamp", () => {
    const descriptor = registry().register(input());
    expect(descriptor.id).toMatch(/^mdl_/);
    expect(descriptor.version).toBe(1);
    expect(descriptor.registeredAt).toBe(FIXED_TIME);
    expect(descriptor.status).toBe("available");
    expect(descriptor.priority).toBe(100);
    expect(descriptor.latencyClass).toBe("unknown");
    expect(descriptor.pricing).toBeNull();
    expect(descriptor.contextWindowTokens).toBe(128_000);
  });

  it("honors values the caller supplies", () => {
    const modelId = createModelId();
    const descriptor = registry().register(
      input({
        id: modelId,
        status: "preview",
        priority: 5,
        latencyClass: "low",
        pricing: {
          currency: "micro_usd",
          inputPerThousandTokens: 300,
          outputPerThousandTokens: 1_500,
          cachedInputPerThousandTokens: null,
          perRequestMicro: null,
        },
        metadata: { family: "reasoning" },
        registeredAt: "2026-01-15T08:30:00.000Z",
      }),
    );
    expect(descriptor.id).toBe(modelId);
    expect(descriptor.status).toBe("preview");
    expect(descriptor.priority).toBe(5);
    expect(descriptor.latencyClass).toBe("low");
    expect(descriptor.pricing?.outputPerThousandTokens).toBe(1_500);
    expect(descriptor.metadata).toEqual({ family: "reasoning" });
    expect(descriptor.registeredAt).toBe("2026-01-15T08:30:00.000Z");
  });

  it("deep-freezes the descriptor so it cannot be changed after registration", () => {
    const descriptor = registry().register(input());
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
    expect(Object.isFrozen(descriptor.modalities)).toBe(true);
    expect(Object.isFrozen(descriptor.modalities.input)).toBe(true);
    expect(Object.isFrozen(descriptor.metadata)).toBe(true);
    expect(() => {
      (descriptor.capabilities as string[]).push("vision");
    }).toThrow();
  });

  it("copies the caller's arrays so a later mutation cannot reach the registry", () => {
    const capabilities = ["chat"] as Array<"chat" | "vision">;
    const subject = registry();
    const descriptor = subject.register(
      input({ capabilities, modalities: { input: ["text"], output: ["text"] } }),
    );
    capabilities.push("vision");
    expect(descriptor.capabilities).toEqual(["chat"]);
    expect(subject.findByCapability("vision")).toEqual([]);
  });

  it("redacts a secret-shaped metadata value on the way in", () => {
    // Registry contents are serialized into events, audit rows and API responses, so a
    // credential pasted into metadata would otherwise be published by all three.
    const credential = `AIza${"A".repeat(35)}`;
    const descriptor = registry().register(input({ metadata: { note: `key ${credential}` } }));
    expect(String(descriptor.metadata["note"])).not.toContain(credential);
  });

  it("rejects an input that fails schema validation", () => {
    const subject = registry();
    expect(() => subject.register(input({ slug: "Bad Slug!" }))).toThrow(ValidationError);
    expect(() => subject.register(input({ capabilities: [] }))).toThrow(ValidationError);
    expect(() => subject.register(input({ capabilities: ["telepathy"] as never }))).toThrow(
      ValidationError,
    );
    expect(() => subject.register(input({ contextWindowTokens: -1 }))).toThrow(ValidationError);
    expect(() => subject.register(input({ contextWindowTokens: 1.5 }))).toThrow(ValidationError);
    expect(() => subject.register(input({ modalities: { input: [], output: ["text"] } }))).toThrow(
      ValidationError,
    );
    expect(() =>
      subject.register(
        input({
          pricing: {
            currency: "micro_usd",
            inputPerThousandTokens: 1.5,
            outputPerThousandTokens: 2,
            cachedInputPerThousandTokens: null,
            perRequestMicro: null,
          },
        }),
      ),
    ).toThrow(ValidationError);
    expect(subject.size).toBe(0);
  });

  it("rejects a duplicate slug and a duplicate identifier", () => {
    const subject = registry();
    const first = subject.register(input());
    expect(() => subject.register(input({ providerId: createProviderId() }))).toThrow(
      ConflictError,
    );
    expect(() => subject.register(input({ slug: "other-model", id: first.id }))).toThrow(
      ConflictError,
    );
    expect(subject.size).toBe(1);
  });

  it("rejects registration past its capacity", () => {
    const subject = new InMemoryModelRegistry({ clock: () => FIXED_TIME, maxEntries: 2 });
    subject.register(input({ slug: "model-a" }));
    subject.register(input({ slug: "model-b" }));
    expect(() => subject.register(input({ slug: "model-c" }))).toThrow(ConflictError);
    expect(subject.size).toBe(2);
  });

  it("rejects a nonsensical capacity", () => {
    expect(() => new InMemoryModelRegistry({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new InMemoryModelRegistry({ maxEntries: 1.5 })).toThrow(RangeError);
  });
});

describe("lookup", () => {
  it("gets, requires and tests membership by identifier", () => {
    const subject = registry();
    const descriptor = subject.register(input());
    expect(subject.get(descriptor.id)).toBe(descriptor);
    expect(subject.require(descriptor.id)).toBe(descriptor);
    expect(subject.has(descriptor.id)).toBe(true);

    const missing = createModelId();
    expect(subject.get(missing)).toBeNull();
    expect(subject.has(missing)).toBe(false);
    expect(() => subject.require(missing)).toThrow(NotFoundError);
  });

  it("looks up by slug and maps a slug back to its identifier", () => {
    const subject = registry();
    const descriptor = subject.register(input());
    expect(subject.hasSlug("reasoning-large")).toBe(true);
    expect(subject.getBySlug("reasoning-large")).toBe(descriptor);
    expect(subject.idForSlug("reasoning-large")).toBe(descriptor.id);
    expect(subject.getBySlug("missing")).toBeNull();
    expect(subject.idForSlug("missing")).toBeNull();
  });

  it("returns a retired model from get but not from resolve", () => {
    // `get` serves inspection and audit; `resolve` serves routing, and routing must never
    // send work to a model that has been taken out of service.
    const subject = registry();
    const descriptor = subject.register(input());
    subject.setStatus(descriptor.id, "retired");
    expect(subject.get(descriptor.id)?.status).toBe("retired");
    expect(subject.resolve(modelById(descriptor.id))).toBeNull();
  });
});

describe("removal", () => {
  it("removes a model and frees its slug", () => {
    const subject = registry();
    const descriptor = subject.register(input());
    expect(subject.remove(descriptor.id)).toBe(true);
    expect(subject.size).toBe(0);
    expect(subject.has(descriptor.id)).toBe(false);
    expect(subject.hasSlug("reasoning-large")).toBe(false);
    expect(() => subject.register(input())).not.toThrow();
  });

  it("reports false when the model was never registered", () => {
    expect(registry().remove(createModelId())).toBe(false);
  });

  it("does not free a slug that belongs to a different model", () => {
    const subject = registry();
    const first = subject.register(input({ slug: "shared" }));
    subject.remove(first.id);
    const second = subject.register(input({ slug: "shared" }));
    expect(subject.idForSlug("shared")).toBe(second.id);
    expect(subject.remove(first.id)).toBe(false);
    expect(subject.hasSlug("shared")).toBe(true);
  });
});

describe("listing and querying", () => {
  function populated() {
    const subject = registry();
    const providerA = createProviderId();
    const providerB = createProviderId();
    // Two models share priority 10, so the comparator's next tie-break — capability
    // breadth — decides their order: reasoning-xl (4 capabilities) precedes fast-cheap (2).
    const cheap = subject.register(
      input({
        slug: "fast-cheap",
        providerId: providerA,
        kind: "fast",
        capabilities: ["chat", "streaming"],
        priority: 10,
        contextWindowTokens: 32_000,
        maxOutputTokens: 4_096,
      }),
    );
    const capable = subject.register(
      input({
        slug: "reasoning-xl",
        providerId: providerB,
        capabilities: ["chat", "streaming", "tool_calling", "vision"],
        priority: 10,
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
    );
    const preview = subject.register(
      input({
        slug: "experimental",
        providerId: providerA,
        kind: "custom",
        status: "preview",
        priority: 90,
        capabilities: ["chat"],
        contextWindowTokens: 8_000,
        maxOutputTokens: 1_000,
      }),
    );
    return { subject, providerA, providerB, cheap, capable, preview };
  }

  it("lists every model in a deterministic order", () => {
    const { subject, cheap, capable, preview } = populated();
    const listed = subject.list();
    expect(listed.map((descriptor) => descriptor.slug)).toEqual([
      capable.slug,
      cheap.slug,
      preview.slug,
    ]);
    // Same contents, same order, on every call — selection downstream takes the first.
    expect(subject.list().map((descriptor) => descriptor.id)).toEqual(
      listed.map((descriptor) => descriptor.id),
    );
  });

  it("returns a frozen copy that cannot be used to reorder the registry", () => {
    const { subject } = populated();
    const listed = subject.list();
    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => {
      (listed as unknown[]).reverse();
    }).toThrow();
    expect(subject.list()[0]?.slug).toBe("reasoning-xl");
  });

  it("finds by capability", () => {
    const { subject } = populated();
    expect(subject.findByCapability("tool_calling").map((descriptor) => descriptor.slug)).toEqual([
      "reasoning-xl",
    ]);
    expect(subject.findByCapability("vision").map((descriptor) => descriptor.slug)).toEqual([
      "reasoning-xl",
    ]);
    expect(subject.findByCapability("chat").map((descriptor) => descriptor.slug)).toEqual([
      "reasoning-xl",
      "fast-cheap",
      "experimental",
    ]);
    expect(subject.findByCapability("embeddings")).toEqual([]);
  });

  it("finds by provider", () => {
    const { subject, providerA, providerB } = populated();
    expect(subject.findByProvider(providerA).map((descriptor) => descriptor.slug)).toEqual([
      "fast-cheap",
      "experimental",
    ]);
    expect(subject.findByProvider(providerB).map((descriptor) => descriptor.slug)).toEqual([
      "reasoning-xl",
    ]);
    expect(subject.findByProvider(createProviderId())).toEqual([]);
  });

  it("narrows by every query criterion at once", () => {
    const { subject, providerA } = populated();
    expect(subject.find({ capabilities: ["chat", "streaming"] }).map((d) => d.slug)).toEqual([
      "reasoning-xl",
      "fast-cheap",
    ]);
    expect(subject.find({ capabilities: ["vision"] }).map((d) => d.slug)).toEqual(["reasoning-xl"]);
    expect(subject.find({ providerId: providerA, kind: "fast" }).map((d) => d.slug)).toEqual([
      "fast-cheap",
    ]);
    expect(subject.find({ providerId: providerA }).map((d) => d.slug)).toEqual([
      "fast-cheap",
      "experimental",
    ]);
    expect(subject.find({ statuses: ["preview"] }).map((d) => d.slug)).toEqual(["experimental"]);
    expect(subject.find({ statuses: ["available", "preview"] })).toHaveLength(3);
    expect(subject.find({ minContextWindowTokens: 100_000 }).map((d) => d.slug)).toEqual([
      "reasoning-xl",
    ]);
    expect(subject.find({ minMaxOutputTokens: 8_192 }).map((d) => d.slug)).toEqual([
      "reasoning-xl",
    ]);
    expect(subject.find({ kind: "reasoning" }).map((d) => d.slug)).toEqual(["reasoning-xl"]);
    expect(subject.find({ inputModalities: ["image"] }).map((d) => d.slug)).toEqual([
      "reasoning-xl",
    ]);
    expect(subject.find({ outputModalities: ["audio"] })).toEqual([]);
  });

  it("applies a limit after ordering, so the same query always returns the same models", () => {
    const { subject } = populated();
    expect(subject.find({ capabilities: ["chat"], limit: 1 }).map((d) => d.slug)).toEqual([
      "reasoning-xl",
    ]);
    expect(subject.find({ capabilities: ["chat"], limit: 2 }).map((d) => d.slug)).toEqual([
      "reasoning-xl",
      "fast-cheap",
    ]);
    expect(subject.find({ capabilities: ["chat"], limit: 99 })).toHaveLength(3);
  });

  it("returns everything when the query is empty", () => {
    const { subject } = populated();
    expect(subject.find({})).toHaveLength(3);
  });
});

describe("resolution", () => {
  it("resolves an exact identifier", () => {
    const subject = registry();
    const descriptor = subject.register(input());
    const resolution = subject.resolve(modelById(descriptor.id));
    expect(resolution?.descriptor).toBe(descriptor);
    expect(resolution?.matchedBy).toBe("id");
    expect(resolution?.candidates).toHaveLength(1);
  });

  it("resolves a slug, scoped or unscoped", () => {
    const subject = registry();
    const descriptor = subject.register(input());
    expect(subject.resolve(modelBySlug("reasoning-large"))?.descriptor).toBe(descriptor);
    expect(subject.resolve(modelBySlug("reasoning-large", descriptor.providerId))?.descriptor).toBe(
      descriptor,
    );
    expect(subject.resolve(modelBySlug("reasoning-large", createProviderId()))).toBeNull();
    expect(subject.resolve(modelBySlug("missing"))).toBeNull();
  });

  it("resolves a capability request deterministically", () => {
    const subject = registry();
    const preferred = subject.register(input({ slug: "preferred", priority: 1 }));
    subject.register(input({ slug: "fallback", priority: 50 }));

    const first = subject.resolve(modelByCapability("chat"));
    const second = subject.resolve(modelByCapability("chat"));
    expect(first?.descriptor).toBe(preferred);
    expect(first?.matchedBy).toBe("capability");
    expect(first?.candidates.map((descriptor) => descriptor.slug)).toEqual([
      "preferred",
      "fallback",
    ]);
    expect(second?.descriptor).toBe(first?.descriptor);
  });

  it("respects a capability request's minimums", () => {
    const subject = registry();
    subject.register(
      input({ slug: "small", contextWindowTokens: 8_000, maxOutputTokens: 1_000, priority: 1 }),
    );
    const large = subject.register(
      input({ slug: "large", contextWindowTokens: 200_000, maxOutputTokens: 16_000, priority: 9 }),
    );

    expect(
      subject.resolve(modelByCapability("chat", { minContextWindowTokens: 100_000 }))?.descriptor,
    ).toBe(large);
    expect(
      subject.resolve(modelByCapability("chat", { minMaxOutputTokens: 8_000 }))?.descriptor,
    ).toBe(large);
    expect(
      subject.resolve(modelByCapability("chat", { minContextWindowTokens: 1_000_000 })),
    ).toBeNull();
  });

  it("resolves a capability request scoped to a kind and a provider", () => {
    const subject = registry();
    const providerId = createProviderId();
    subject.register(input({ slug: "reasoning-a", providerId, kind: "reasoning", priority: 1 }));
    const fast = subject.register(input({ slug: "fast-a", providerId, kind: "fast", priority: 2 }));
    expect(
      subject.resolve(modelByCapability("chat", { modelKind: "fast", providerId }))?.descriptor,
    ).toBe(fast);
    expect(
      subject.resolve(modelByCapability("chat", { modelKind: "embedding", providerId })),
    ).toBeNull();
  });

  it("never resolves to a retired model", () => {
    const subject = registry();
    const retired = subject.register(input({ slug: "old", priority: 1 }));
    const current = subject.register(input({ slug: "new", priority: 9 }));
    subject.setStatus(retired.id, "retired");
    expect(subject.resolve(modelByCapability("chat"))?.descriptor).toBe(current);
    expect(subject.resolve(modelBySlug("old"))).toBeNull();
    expect(isSelectableModelStatus("retired")).toBe(false);
  });

  it("throws a typed error when a required reference does not resolve", () => {
    const subject = registry();
    expect(() => subject.requireReference(modelBySlug("missing"))).toThrow(NotFoundError);
    const descriptor = subject.register(input());
    expect(subject.requireReference(modelById(descriptor.id)).descriptor).toBe(descriptor);
  });
});

describe("lifecycle status", () => {
  it("replaces the descriptor and bumps the version instead of mutating", () => {
    const subject = registry();
    const original = subject.register(input());
    const degraded = subject.setStatus(original.id, "degraded");

    expect(degraded).not.toBe(original);
    expect(degraded.status).toBe("degraded");
    expect(degraded.version).toBe(2);
    expect(degraded.registeredAt).toBe(original.registeredAt);
    // The descriptor an execution already recorded still says what was true then.
    expect(original.status).toBe("available");
    expect(original.version).toBe(1);
    expect(subject.get(original.id)).toBe(degraded);
  });

  it("returns the same descriptor when the status is unchanged", () => {
    const subject = registry();
    const descriptor = subject.register(input());
    expect(subject.setStatus(descriptor.id, "available")).toBe(descriptor);
    expect(subject.require(descriptor.id).version).toBe(1);
  });

  it("counts each transition as a new version", () => {
    const subject = registry();
    const descriptor = subject.register(input());
    expect(subject.setStatus(descriptor.id, "preview").version).toBe(2);
    expect(subject.setStatus(descriptor.id, "degraded").version).toBe(3);
    expect(subject.setStatus(descriptor.id, "retired").version).toBe(4);
  });

  it("treats retired as terminal", () => {
    const subject = registry();
    const descriptor = subject.register(input());
    subject.setStatus(descriptor.id, "retired");
    expect(() => subject.setStatus(descriptor.id, "available")).toThrow(ValidationError);
    expect(MODEL_STATUS_TRANSITIONS.retired).toEqual([]);
  });

  it("throws when the model is not registered", () => {
    expect(() => registry().setStatus(createModelId(), "degraded")).toThrow(NotFoundError);
  });

  it("allows every non-retired status to reach retired", () => {
    for (const from of ["available", "preview", "degraded"] as const) {
      expect(isLegalModelStatusTransition(from, "retired"), from).toBe(true);
    }
    expect(isLegalModelStatusTransition("available", "available")).toBe(true);
    expect(isLegalModelStatusTransition("retired", "available")).toBe(false);
  });
});
