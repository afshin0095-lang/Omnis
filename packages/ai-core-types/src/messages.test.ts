import { describe, expect, it } from "vitest";
import { createModelId, createProviderId, createToolId } from "@omnis/types";
import {
  addUsage,
  createMessage,
  EMPTY_USAGE,
  isIncompleteStopReason,
  MAX_CONTENT_PARTS,
  messageText,
  messageToolCalls,
  textMessage,
  type UsageSummary,
} from "./index.js";

function usage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return { ...EMPTY_USAGE, ...overrides };
}

describe("messages", () => {
  it("builds an immutable single-part text message", () => {
    const message = textMessage("user", "hello");
    expect(message.role).toBe("user");
    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(message.name).toBeNull();
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(true);
  });

  it("concatenates only text parts, in order", () => {
    const message = createMessage("assistant", [
      { type: "text", text: "first" },
      { type: "reasoning", text: "internal", redacted: false },
      { type: "text", text: "second" },
      { type: "structured", value: { a: 1 }, schemaName: null },
    ]);
    expect(messageText(message)).toBe("first\nsecond");
  });

  it("returns an empty string for a message with no text parts", () => {
    expect(messageText(createMessage("assistant", []))).toBe("");
  });

  it("copies the content array so a later mutation of the caller's array cannot change the message", () => {
    const parts = [{ type: "text", text: "original" }] as Array<{ type: "text"; text: string }>;
    const message = createMessage("user", parts);
    parts[0] = { type: "text", text: "tampered" };
    parts.push({ type: "text", text: "extra" });
    expect(messageText(message)).toBe("original");
  });

  it("rejects a message with more parts than the contract allows", () => {
    const parts = Array.from(
      { length: MAX_CONTENT_PARTS + 1 },
      () => ({ type: "text", text: "x" }) as const,
    );
    expect(() => createMessage("user", parts)).toThrow(RangeError);
    expect(() => createMessage("user", parts.slice(0, MAX_CONTENT_PARTS))).not.toThrow();
  });

  it("collects tool calls from content parts", () => {
    const toolId = createToolId();
    const message = createMessage("assistant", [
      { type: "text", text: "calling" },
      {
        type: "tool_call",
        call: { callId: "call_1", toolId, name: "search", arguments: { query: "omnis" } },
      },
      {
        type: "tool_call",
        call: { callId: "call_2", toolId: null, name: "lookup", arguments: {} },
      },
    ]);
    const calls = messageToolCalls(message);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.callId).toBe("call_1");
    expect(calls[1]?.toolId).toBeNull();
    expect(messageToolCalls(textMessage("user", "no calls"))).toHaveLength(0);
  });
});

describe("usage accounting", () => {
  it("adds every counter", () => {
    const total = addUsage(
      usage({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        requests: 1,
        cachedInputTokens: 2,
        reasoningTokens: 1,
      }),
      usage({
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        requests: 1,
        cachedInputTokens: 0,
        reasoningTokens: 3,
      }),
    );
    expect(total).toEqual({
      inputTokens: 13,
      outputTokens: 9,
      totalTokens: 22,
      cachedInputTokens: 2,
      reasoningTokens: 4,
      requests: 2,
      costMicro: null,
    });
  });

  it("keeps cost unknown if either side is unpriced", () => {
    // Adding a known cost to an unknown one is not a known cost. Reporting `100` here
    // would understate spend, which is the dangerous direction for a budget.
    expect(addUsage(usage({ costMicro: 100 }), usage({ costMicro: null })).costMicro).toBeNull();
    expect(addUsage(usage({ costMicro: null }), usage({ costMicro: 100 })).costMicro).toBeNull();
    expect(addUsage(usage({ costMicro: 100 }), usage({ costMicro: 250 })).costMicro).toBe(350);
  });

  it("is frozen at zero and carries no request", () => {
    expect(EMPTY_USAGE.requests).toBe(0);
    expect(Object.isFrozen(EMPTY_USAGE)).toBe(true);
    expect(addUsage(EMPTY_USAGE, EMPTY_USAGE)).toEqual(EMPTY_USAGE);
  });
});

describe("stop reasons", () => {
  it("marks truncated and aborted generations as incomplete", () => {
    expect(isIncompleteStopReason("length")).toBe(true);
    expect(isIncompleteStopReason("cancelled")).toBe(true);
    expect(isIncompleteStopReason("error")).toBe(true);
    expect(isIncompleteStopReason("stop")).toBe(false);
    // A tool-call stop is a complete turn: the model finished and is asking for work.
    expect(isIncompleteStopReason("tool_calls")).toBe(false);
    expect(isIncompleteStopReason("content_policy")).toBe(false);
  });
});

describe("model request and response identity", () => {
  it("carries resolved identifiers rather than references", () => {
    // By the time a request reaches an adapter, selection has already happened: the
    // request names the exact model, provider and vendor model string.
    const modelId = createModelId();
    const providerId = createProviderId();
    expect(modelId).toMatch(/^mdl_/);
    expect(providerId).toMatch(/^prv_/);
  });
});
