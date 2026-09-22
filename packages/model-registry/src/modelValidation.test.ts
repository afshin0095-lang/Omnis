import { describe, expect, it } from "vitest";
import { createModelId, createProviderId } from "@omnis/types";
import { tryValidate } from "@omnis/validation";
import { modelByCapability, modelById, modelBySlug } from "@omnis/ai-core-types";
import type { ModelRegistrationInput } from "./modelValidation.js";
import {
  isModelSlug,
  MODEL_DESCRIPTOR_CONTRACT,
  modelDescriptorSchema,
  MODEL_REGISTRATION_CONTRACT,
  modelQuerySchema,
  modelReferenceSchema,
  modelRegistrationInputSchema,
} from "./modelValidation.js";
import { InMemoryModelRegistry } from "./InMemoryModelRegistry.js";

const registration: ModelRegistrationInput = {
  slug: "reasoning-large",
  displayName: "Reasoning Large",
  providerId: createProviderId(),
  kind: "reasoning",
  capabilities: ["chat", "streaming"],
  modalities: { input: ["text"], output: ["text"] },
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  providerModelName: "vendor-reasoning-large",
};

describe("slug schema", () => {
  it("accepts lowercase slugs with separators", () => {
    for (const slug of ["ab", "reasoning-large", "gpt_4o", "claude.v3", "a1"]) {
      expect(isModelSlug(slug), slug).toBe(true);
    }
  });

  it("rejects slugs that would need escaping or are ambiguous", () => {
    for (const slug of [
      "",
      "a",
      "Bad",
      "with space",
      "-leading",
      ".leading",
      "trailing/",
      "trailing-",
      "trailing_",
      "trailing.",
      "x".repeat(65),
      "slüg",
    ]) {
      expect(isModelSlug(slug), slug).toBe(false);
    }
  });
});

describe("registration schema", () => {
  it("accepts a minimal registration", () => {
    const result = tryValidate(modelRegistrationInputSchema, registration);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown capability, kind or status", () => {
    expect(
      tryValidate(modelRegistrationInputSchema, { ...registration, capabilities: ["telepathy"] })
        .ok,
    ).toBe(false);
    expect(tryValidate(modelRegistrationInputSchema, { ...registration, kind: "quantum" }).ok).toBe(
      false,
    );
    expect(
      tryValidate(modelRegistrationInputSchema, { ...registration, status: "paused" }).ok,
    ).toBe(false);
  });

  it("rejects fractional or negative numbers", () => {
    expect(tryValidate(modelRegistrationInputSchema, { ...registration, priority: -1 }).ok).toBe(
      false,
    );
    expect(tryValidate(modelRegistrationInputSchema, { ...registration, priority: 1.5 }).ok).toBe(
      false,
    );
    expect(
      tryValidate(modelRegistrationInputSchema, { ...registration, maxOutputTokens: -8 }).ok,
    ).toBe(false);
  });

  it("rejects a malformed identifier", () => {
    expect(
      tryValidate(modelRegistrationInputSchema, { ...registration, id: "mdl_not-a-ulid" }).ok,
    ).toBe(false);
    expect(
      tryValidate(modelRegistrationInputSchema, { ...registration, providerId: createModelId() })
        .ok,
    ).toBe(false);
  });

  it("rejects fractional pricing because the ledger cannot represent it", () => {
    const pricing = {
      currency: "micro_usd",
      inputPerThousandTokens: 1.5,
      outputPerThousandTokens: 2,
      cachedInputPerThousandTokens: null,
      perRequestMicro: null,
    };
    expect(tryValidate(modelRegistrationInputSchema, { ...registration, pricing }).ok).toBe(false);
    expect(
      tryValidate(modelRegistrationInputSchema, {
        ...registration,
        pricing: { ...pricing, inputPerThousandTokens: 1 },
      }).ok,
    ).toBe(true);
  });
});

describe("descriptor schema", () => {
  it("accepts a descriptor the registry produced", () => {
    const descriptor = new InMemoryModelRegistry({
      clock: () => "2026-03-01T12:00:00.000Z",
    }).register(registration);
    const result = tryValidate(modelDescriptorSchema, descriptor);
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  });

  it("rejects a descriptor missing registry-assigned fields", () => {
    // A caller must not be able to fabricate a descriptor claiming a version or an
    // identifier it was not given.
    expect(tryValidate(modelDescriptorSchema, registration).ok).toBe(false);
    expect(
      tryValidate(modelDescriptorSchema, { ...registration, id: createModelId(), version: 0 }).ok,
    ).toBe(false);
  });
});

describe("reference schema", () => {
  it("accepts all three reference kinds", () => {
    for (const reference of [
      modelById(createModelId()),
      modelBySlug("reasoning-large", null),
      modelByCapability("chat", { minContextWindowTokens: 1_000 }),
    ]) {
      expect(tryValidate(modelReferenceSchema, reference).ok, reference.kind).toBe(true);
    }
  });

  it("rejects an unknown kind and a malformed slug reference", () => {
    expect(tryValidate(modelReferenceSchema, { kind: "name", slug: "x" }).ok).toBe(false);
    expect(
      tryValidate(modelReferenceSchema, { kind: "slug", slug: "Bad Slug", providerId: null }).ok,
    ).toBe(false);
  });
});

describe("query schema", () => {
  it("accepts an empty query and a fully specified one", () => {
    expect(tryValidate(modelQuerySchema, {}).ok).toBe(true);
    expect(
      tryValidate(modelQuerySchema, {
        capabilities: ["chat"],
        providerId: createProviderId(),
        statuses: ["available"],
        minContextWindowTokens: 1_000,
        limit: 5,
      }).ok,
    ).toBe(true);
  });

  it("rejects a non-positive or oversized limit", () => {
    expect(tryValidate(modelQuerySchema, { limit: 0 }).ok).toBe(false);
    expect(tryValidate(modelQuerySchema, { limit: 10_000 }).ok).toBe(false);
  });
});

describe("schema contracts", () => {
  it("name the contract and version in their descriptors", () => {
    expect(MODEL_DESCRIPTOR_CONTRACT.contractId).toBe("ModelDescriptor");
    expect(MODEL_DESCRIPTOR_CONTRACT.version).toBe("1.0.0");
    expect(MODEL_REGISTRATION_CONTRACT.contractId).toBe("ModelRegistration");
  });
});
