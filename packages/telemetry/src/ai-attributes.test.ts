import { describe, expect, it } from "vitest";
import {
  AI_METRIC_ATTRIBUTE_KEYS,
  AI_SPAN_ATTRIBUTE_KEYS,
  aiMetricAttributes,
  aiSpanAttributes,
  assertAiMetricAttributes,
  isAiAttributeKey,
} from "./ai-attributes.js";

describe("the AI Core namespace", () => {
  it("names every key with the omnis.ai prefix", () => {
    for (const key of [
      ...Object.values(AI_SPAN_ATTRIBUTE_KEYS),
      ...Object.values(AI_METRIC_ATTRIBUTE_KEYS),
    ]) {
      expect(isAiAttributeKey(key), key).toBe(true);
    }
  });

  it("has no duplicate wire names", () => {
    const spanKeys = Object.values(AI_SPAN_ATTRIBUTE_KEYS);
    expect(new Set(spanKeys).size).toBe(spanKeys.length);
    const metricKeys = Object.values(AI_METRIC_ATTRIBUTE_KEYS);
    expect(new Set(metricKeys).size).toBe(metricKeys.length);
  });

  it("keeps every metric label inside the span vocabulary", () => {
    const spanKeys = new Set<string>(Object.values(AI_SPAN_ATTRIBUTE_KEYS));
    for (const key of Object.values(AI_METRIC_ATTRIBUTE_KEYS)) {
      expect(spanKeys.has(key), key).toBe(true);
    }
  });
});

describe("aiSpanAttributes", () => {
  it("maps short names to wire names", () => {
    expect(aiSpanAttributes({ toolName: "search", attempt: 2, timedOut: false })).toEqual({
      "omnis.ai.tool.name": "search",
      "omnis.ai.attempt": 2,
      "omnis.ai.timed_out": false,
    });
  });

  it("drops absent values instead of rendering them", () => {
    expect(aiSpanAttributes({ modelId: null, providerId: undefined, toolName: "search" })).toEqual({
      "omnis.ai.tool.name": "search",
    });
  });

  it("refuses content, objects and non-finite numbers", () => {
    expect(() => aiSpanAttributes({ toolName: { prompt: "tell me a secret" } })).toThrow(
      RangeError,
    );
    expect(() => aiSpanAttributes({ toolName: ["a"] })).toThrow(RangeError);
    expect(() => aiSpanAttributes({ durationMs: Number.NaN })).toThrow(RangeError);
    expect(() => aiSpanAttributes({ durationMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("refuses a name outside the vocabulary", () => {
    expect(() => aiSpanAttributes({ notAKey: "x" } as never)).toThrow(RangeError);
  });

  it("returns a frozen record", () => {
    expect(Object.isFrozen(aiSpanAttributes({ attempt: 1 }))).toBe(true);
  });
});

describe("aiMetricAttributes", () => {
  it("accepts the bounded vocabulary", () => {
    expect(
      aiMetricAttributes({ toolKind: "read", policyOutcome: "allow", retryable: false }),
    ).toEqual({
      "omnis.ai.tool.kind": "read",
      "omnis.ai.policy.outcome": "allow",
      "omnis.ai.retryable": false,
    });
  });

  it("refuses identifiers, which belong on spans", () => {
    expect(() => aiMetricAttributes({ modelId: "mdl_1" } as never)).toThrow(RangeError);
    expect(() => aiMetricAttributes({ executionId: "exe_1" } as never)).toThrow(RangeError);
    expect(() => aiMetricAttributes({ toolName: "search" } as never)).toThrow(RangeError);
  });

  it("guards a label set built elsewhere", () => {
    expect(() => assertAiMetricAttributes(aiMetricAttributes({ toolKind: "read" }))).not.toThrow();
    expect(() => assertAiMetricAttributes({ "omnis.ai.execution.id": "exe_1" })).toThrow(
      RangeError,
    );
    expect(() => assertAiMetricAttributes({ "omnis.environment": "production" })).toThrow(
      RangeError,
    );
  });
});
