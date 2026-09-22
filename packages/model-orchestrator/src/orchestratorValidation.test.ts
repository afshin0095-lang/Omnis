import { describe, expect, it } from "vitest";
import { createModelId, createProviderId } from "@omnis/types";
import {
  AI_CORE_CONTRACT_VERSION,
  modelByCapability,
  modelById,
  modelBySlug,
} from "@omnis/ai-core-types";
import type { Message } from "@omnis/ai-core-types";
import { ValidationError } from "@omnis/errors";
import { validate } from "@omnis/validation";
import { MAX_PROVIDER_ATTEMPTS, providerAttempt } from "./ModelCall.js";
import {
  isMessage,
  isMessageList,
  MAX_REPORTED_ATTEMPTS,
  MAX_TOOLS_PER_CALL,
  MODEL_CALL_REQUEST_CONTRACT,
  modelCallRequestSchema,
  PROVIDER_ATTEMPT_CONTRACT,
  providerAttemptSchema,
} from "./orchestratorValidation.js";
import { AT, toolSpec, usageOf } from "./testSupport.js";

const MODEL_ID = createModelId();
const PROVIDER_ID = createProviderId();

function message(overrides: Partial<Message> = {}): Message {
  return {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    name: null,
    metadata: {},
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: modelById(MODEL_ID), messages: [message()], ...overrides };
}

describe("isMessage", () => {
  it("accepts a message with one text part", () => {
    expect(isMessage(message())).toBe(true);
  });

  it("accepts every published role", () => {
    for (const role of ["system", "developer", "user", "assistant", "tool"] as const) {
      expect(isMessage(message({ role }))).toBe(true);
    }
  });

  it("accepts the published content part types", () => {
    const parts: Message["content"] = [
      { type: "text", text: "hi" },
      { type: "reasoning", text: "because", redacted: false },
      {
        type: "image",
        mimeType: "image/png",
        reference: "https://example.invalid/a.png",
        description: null,
      },
      {
        type: "tool_call",
        call: { callId: "call_1", toolId: null, name: "search", arguments: {} },
      },
    ];
    for (const part of parts) {
      expect(isMessage(message({ content: [part] }))).toBe(true);
    }
  });

  it("rejects a role that is not published", () => {
    expect(isMessage({ ...message(), role: "narrator" })).toBe(false);
  });

  it("rejects a content part type that is not published", () => {
    expect(
      isMessage(
        message({ content: [{ type: "hologram", text: "no" }] as unknown as Message["content"] }),
      ),
    ).toBe(false);
  });

  it("rejects content that is not an array", () => {
    expect(isMessage({ ...message(), content: "hello" })).toBe(false);
  });

  it("rejects a name that is not a string or null", () => {
    expect(isMessage({ ...message(), name: 7 })).toBe(false);
    expect(isMessage(message({ name: "assistant-1" }))).toBe(true);
  });

  it("rejects metadata that is not an object", () => {
    expect(isMessage({ ...message(), metadata: "no" })).toBe(false);
  });

  it("rejects values that are not objects at all", () => {
    expect(isMessage(null)).toBe(false);
    expect(isMessage("hello")).toBe(false);
    expect(isMessage(7)).toBe(false);
  });
});

describe("isMessageList", () => {
  it("accepts a conversation", () => {
    expect(isMessageList([message(), message({ role: "assistant" })])).toBe(true);
  });

  it("rejects an empty conversation, because there is nothing to send", () => {
    expect(isMessageList([])).toBe(false);
  });

  it("rejects a list with one bad message", () => {
    expect(isMessageList([message(), { role: "narrator", content: [] }])).toBe(false);
  });

  it("rejects a value that is not a list", () => {
    expect(isMessageList(message())).toBe(false);
  });
});

describe("modelCallRequestSchema", () => {
  it("accepts the smallest useful request", () => {
    const parsed = modelCallRequestSchema.safeParse(request());
    expect(parsed.success).toBe(true);
  });

  it("accepts a slug reference and a capability reference", () => {
    expect(
      modelCallRequestSchema.safeParse(request({ model: modelBySlug("primary") })).success,
    ).toBe(true);
    expect(
      modelCallRequestSchema.safeParse(request({ model: modelBySlug("primary", PROVIDER_ID) }))
        .success,
    ).toBe(true);
    expect(
      modelCallRequestSchema.safeParse(request({ model: modelByCapability("reasoning") })).success,
    ).toBe(true);
  });

  it("rejects a reference that is not a ModelReference", () => {
    expect(
      modelCallRequestSchema.safeParse(request({ model: { kind: "vendor", name: "gpt" } })).success,
    ).toBe(false);
    expect(modelCallRequestSchema.safeParse(request({ model: MODEL_ID })).success).toBe(false);
  });

  it("rejects a field it does not know, because a typo must not be silently dropped", () => {
    expect(modelCallRequestSchema.safeParse(request({ provider: PROVIDER_ID })).success).toBe(
      false,
    );
  });

  it("rejects an empty conversation", () => {
    expect(modelCallRequestSchema.safeParse(request({ messages: [] })).success).toBe(false);
  });

  it("bounds sampling parameters", () => {
    expect(
      modelCallRequestSchema.safeParse(request({ parameters: { temperature: 3 } })).success,
    ).toBe(false);
    expect(modelCallRequestSchema.safeParse(request({ parameters: { topP: 1.5 } })).success).toBe(
      false,
    );
    expect(
      modelCallRequestSchema.safeParse(request({ parameters: { temperature: 0.7, topP: 0.9 } }))
        .success,
    ).toBe(true);
  });

  it("bounds retries to the published maximum", () => {
    expect(
      modelCallRequestSchema.safeParse(request({ maxAttemptsPerProvider: MAX_PROVIDER_ATTEMPTS }))
        .success,
    ).toBe(true);
    expect(
      modelCallRequestSchema.safeParse(
        request({ maxAttemptsPerProvider: MAX_PROVIDER_ATTEMPTS + 1 }),
      ).success,
    ).toBe(false);
    expect(modelCallRequestSchema.safeParse(request({ maxAttemptsPerProvider: 0 })).success).toBe(
      false,
    );
  });

  it("bounds how many providers one call may try", () => {
    expect(
      modelCallRequestSchema.safeParse(request({ maxProviders: MAX_REPORTED_ATTEMPTS })).success,
    ).toBe(true);
    expect(
      modelCallRequestSchema.safeParse(request({ maxProviders: MAX_REPORTED_ATTEMPTS + 1 }))
        .success,
    ).toBe(false);
  });

  it("bounds the tool list", () => {
    expect(modelCallRequestSchema.safeParse(request({ tools: [toolSpec()] })).success).toBe(true);
    expect(
      modelCallRequestSchema.safeParse(
        request({ tools: new Array(MAX_TOOLS_PER_CALL + 1).fill(toolSpec()) }),
      ).success,
    ).toBe(false);
    expect(modelCallRequestSchema.safeParse(request({ tools: [{ name: "search" }] })).success).toBe(
      false,
    );
  });

  it("accepts an approval and an absent one alike", () => {
    expect(modelCallRequestSchema.safeParse(request({ approval: null })).success).toBe(true);
    expect(
      modelCallRequestSchema.safeParse(
        request({ approval: { approved: true, approver: "ops", approvedAt: AT } }),
      ).success,
    ).toBe(true);
    expect(
      modelCallRequestSchema.safeParse(request({ approval: { approved: "yes" } })).success,
    ).toBe(false);
  });

  it("bounds the policy list", () => {
    expect(
      modelCallRequestSchema.safeParse(request({ policyIds: new Array(17).fill("policy") }))
        .success,
    ).toBe(false);
  });

  it("accepts a null deadline and timeout, meaning unbounded", () => {
    expect(
      modelCallRequestSchema.safeParse(request({ deadlineMs: null, timeoutMs: null })).success,
    ).toBe(true);
    expect(modelCallRequestSchema.safeParse(request({ deadlineMs: 0 })).success).toBe(false);
  });

  it("names the contract in the error a caller receives", () => {
    let caught: unknown = null;
    try {
      validate(modelCallRequestSchema, request({ messages: [] }), "ModelCallRequest");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("ModelCallRequest");
  });
});

describe("providerAttemptSchema", () => {
  it("accepts the attempt row the orchestrator writes", () => {
    const attempt = providerAttempt({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      startedAt: AT,
      finishedAt: AT,
      usage: usageOf(),
      status: "succeeded",
    });
    expect(providerAttemptSchema.safeParse(attempt).success).toBe(true);
  });

  it("accepts a failed row carrying its failure", () => {
    const attempt = providerAttempt({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      startedAt: AT,
      finishedAt: AT,
      status: "failed",
      failure: {
        class: "provider_failure",
        code: "provider_failure",
        message: "refused",
        retryable: true,
        retryAfterMs: null,
        attempt: 1,
        stepId: null,
        executionId: null,
        modelId: MODEL_ID,
        providerId: PROVIDER_ID,
        toolId: null,
        details: {},
        occurredAt: AT,
      },
    });
    expect(providerAttemptSchema.safeParse(attempt).success).toBe(true);
  });

  it("rejects a status outside the published three", () => {
    const attempt = {
      ...providerAttempt({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
      status: "pending",
    };
    expect(providerAttemptSchema.safeParse(attempt).success).toBe(false);
  });

  it("rejects a zero attempt number and an attempt beyond the bound", () => {
    expect(
      providerAttemptSchema.safeParse({
        ...providerAttempt({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
        attempt: 0,
      }).success,
    ).toBe(false);
    expect(
      providerAttemptSchema.safeParse({
        ...providerAttempt({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
        attempt: MAX_PROVIDER_ATTEMPTS + 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a usage summary with a negative count", () => {
    const attempt = providerAttempt({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      usage: { ...usageOf(), inputTokens: -1 },
    });
    expect(providerAttemptSchema.safeParse(attempt).success).toBe(false);
  });

  it("rejects a field it does not know", () => {
    const attempt = {
      ...providerAttempt({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
      prompt: "leak",
    };
    expect(providerAttemptSchema.safeParse(attempt).success).toBe(false);
  });
});

describe("the published contracts", () => {
  it("names and versions both shapes", () => {
    expect(MODEL_CALL_REQUEST_CONTRACT.contractId).toBe("ModelCallRequest");
    expect(MODEL_CALL_REQUEST_CONTRACT.version).toBe(AI_CORE_CONTRACT_VERSION);
    expect(PROVIDER_ATTEMPT_CONTRACT.contractId).toBe("ProviderAttempt");
    expect(PROVIDER_ATTEMPT_CONTRACT.version).toBe(AI_CORE_CONTRACT_VERSION);
  });

  it("exposes the schema it describes, so a caller can validate without importing this module twice", () => {
    expect(MODEL_CALL_REQUEST_CONTRACT.schema).toBe(modelCallRequestSchema);
    expect(PROVIDER_ATTEMPT_CONTRACT.schema).toBe(providerAttemptSchema);
  });
});
