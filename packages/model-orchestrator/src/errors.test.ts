import { describe, expect, it } from "vitest";
import { createModelId, createProviderId } from "@omnis/types";
import { modelById, modelByCapability, modelBySlug } from "@omnis/ai-core-types";
import { ConflictError, NotImplementedError, NotFoundError } from "@omnis/errors";
import {
  noModelForReference,
  noProviderAvailable,
  providerNotServable,
  streamingUnsupported,
} from "./errors.js";

const MODEL_ID = createModelId();
const PROVIDER_ID = createProviderId();

describe("noModelForReference", () => {
  it("names the reference in the identifier slot, so a log line points at what was asked for", () => {
    const error = noModelForReference(modelById(MODEL_ID));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.resourceType).toBe("model");
    expect(error.resourceId).toBe(`id:${MODEL_ID}`);
    expect(error.code).toBe("not_found");
    expect(error.retryable).toBe(false);
  });

  it("describes a slug reference with its provider scope when it has one", () => {
    const error = noModelForReference(modelBySlug("reasoner", PROVIDER_ID));
    expect(error.resourceId).toBe(`slug:reasoner@${PROVIDER_ID}`);
    expect(error.metadata).toMatchObject({
      registry: "orchestrator",
      reference: `slug:reasoner@${PROVIDER_ID}`,
    });
  });

  it("describes a capability reference without leaking a prompt", () => {
    const error = noModelForReference(modelByCapability("reasoning"));
    expect(error.resourceId).toBe("capability:reasoning");
    expect(error.message).not.toContain("reasoning is required by the caller");
  });
});

describe("noProviderAvailable", () => {
  it("counts what was tried, so an incident report shows the size of the fallback", () => {
    const error = noProviderAvailable(modelBySlug("primary"), 3, "every candidate failed");
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.resourceType).toBe("provider");
    // Non-retryable: the fallback already happened, so repeating the call would repeat the walk.
    expect(error.retryable).toBe(false);
    expect(error.metadata).toMatchObject({ candidatesTried: 3, reason: "every candidate failed" });
  });

  it("reports zero candidates separately from a failed fallback", () => {
    const error = noProviderAvailable(modelById(MODEL_ID), 0, "no candidate matched");
    expect(error.metadata).toMatchObject({ candidatesTried: 0, reason: "no candidate matched" });
  });
});

describe("providerNotServable", () => {
  it("names the provider and the reason", () => {
    const error = providerNotServable(PROVIDER_ID, "no adapter is registered");
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.conflict).toBe(`provider:${PROVIDER_ID}`);
    expect(error.message).toContain("no adapter is registered");
    expect(error.retryable).toBe(false);
  });
});

describe("streamingUnsupported", () => {
  it("reports the capability that is missing rather than a free-text complaint", () => {
    const error = streamingUnsupported(PROVIDER_ID, MODEL_ID);
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error.capability).toBe("model.stream");
    expect(error.code).toBe("not_implemented");
    expect(error.retryable).toBe(false);
    expect(error.metadata).toMatchObject({ providerId: PROVIDER_ID, modelId: MODEL_ID });
  });

  it("does not name a vendor, because the orchestrator does not know one", () => {
    const error = streamingUnsupported(PROVIDER_ID, MODEL_ID);
    expect(error.message.toLowerCase()).not.toContain("openai");
    expect(error.message.toLowerCase()).not.toContain("anthropic");
  });
});

describe("the error surface as a whole", () => {
  it("produces errors a caller can catch as one family", () => {
    const errors = [
      noModelForReference(modelById(MODEL_ID)),
      noProviderAvailable(modelById(MODEL_ID), 1, "failed"),
      providerNotServable(PROVIDER_ID, "no adapter"),
      streamingUnsupported(PROVIDER_ID, MODEL_ID),
    ];
    for (const error of errors) {
      expect(error.name).toBeTruthy();
      expect(typeof error.code).toBe("string");
      expect(error.metadata).toMatchObject({ registry: "orchestrator" });
    }
  });

  it("carries identifiers and short reasons, never a conversation", () => {
    // These factories are the whole error vocabulary of the orchestrator, and none of them takes a
    // message, a prompt or a model output: an error is logged, audited and sometimes returned by an
    // API, so the only safe thing to put in one is an identifier and a reason.
    const errors = [
      noModelForReference(modelBySlug("primary")),
      noProviderAvailable(modelBySlug("primary"), 2, "every candidate failed"),
      providerNotServable(PROVIDER_ID, "the provider has no credentials configured"),
      streamingUnsupported(PROVIDER_ID, MODEL_ID),
    ];
    for (const error of errors) {
      const rendered = JSON.stringify({
        message: error.message,
        metadata: error.metadata,
      }).toLowerCase();
      expect(rendered).not.toContain("messages");
      expect(rendered).not.toContain("prompt");
      expect(rendered).not.toContain("content");
    }
  });
});
