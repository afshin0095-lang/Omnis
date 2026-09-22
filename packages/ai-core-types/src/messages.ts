/**
 * Message and model I/O contracts.
 *
 * These are the *normalized* shapes: one vocabulary for conversation content that
 * every provider adapter maps into and out of. The alternative — letting vendor
 * message shapes leak upward — is what turns "swap the model provider" into a
 * six-week refactor, and makes it impossible to evaluate or replay an execution
 * without the original vendor.
 *
 * Rules encoded here:
 * - `ContentPart` is a discriminated union on `type`. A message that is "just a
 *   string" cannot express a tool call, an image or a schema-validated payload, and
 *   every one of those exists in the first real agent run.
 * - Media parts carry a *reference*, never inline bytes. Inline base64 in a message
 *   means inline base64 in an event payload, a log line and an audit row.
 * - Tool calls are data, not callbacks: a model response *requests* a call, the Tool
 *   Runtime decides whether to run it. Nothing in this module can execute anything.
 */

import type { JsonValue } from "@omnis/types";
import type { AiCoreMetadata } from "./constants.js";
import { MAX_CONTENT_PARTS } from "./constants.js";
import type { ModelId, ProviderId, ToolId } from "./identifiers.js";
import type { ModelParameters } from "./model.js";
import type { ToolParameterSchema } from "./tool.js";

/** Who produced a message. `developer` is distinct from `system`: operator-level instructions that outrank user input but are not the model's own preamble. */
export const MESSAGE_ROLES = ["system", "developer", "user", "assistant", "tool"] as const;

/** The producer of a message. */
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Plain natural-language content. */
export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

/**
 * Machine-structured content whose shape the caller validated.
 *
 * Kept separate from `text` so a consumer can tell "the model produced prose that
 * happens to look like JSON" from "the model produced a payload that satisfied the
 * requested schema" — the difference matters for evaluation and for retry policy.
 */
export interface StructuredContent {
  readonly type: "structured";
  readonly value: JsonValue;
  /** Name of the schema the value satisfies, when one was requested. */
  readonly schemaName: string | null;
}

/** Image content, by reference. */
export interface ImageContent {
  readonly type: "image";
  readonly mimeType: string;
  /** Storage or URL reference resolved by an adapter. Never inline bytes. */
  readonly reference: string;
  readonly description: string | null;
}

/** Audio content, by reference. */
export interface AudioContent {
  readonly type: "audio";
  readonly mimeType: string;
  readonly reference: string;
  readonly durationMs: number | null;
  /** Transcript when one is already known, so the model need not re-transcribe. */
  readonly transcript: string | null;
}

/** Document or file content, by reference. */
export interface FileContent {
  readonly type: "file";
  readonly mimeType: string;
  readonly reference: string;
  readonly name: string;
}

/**
 * Model-visible reasoning trace.
 *
 * Recorded when a reasoning model exposes it, and explicitly *not* re-sent as
 * authoritative content: a reasoning trace is an explanation, not an instruction.
 */
export interface ReasoningContent {
  readonly type: "reasoning";
  readonly text: string;
  readonly redacted: boolean;
}

/** A tool invocation requested by the model. */
export interface ToolCallContent {
  readonly type: "tool_call";
  readonly call: ToolCallRequest;
}

/** The result of a tool invocation, returned to the model. */
export interface ToolResultContent {
  readonly type: "tool_result";
  readonly result: ToolCallResponse;
}

/** One piece of message content. */
export type ContentPart =
  | TextContent
  | StructuredContent
  | ImageContent
  | AudioContent
  | FileContent
  | ReasoningContent
  | ToolCallContent
  | ToolResultContent;

/** The `type` discriminants of {@link ContentPart}, in declaration order. */
export const CONTENT_PART_TYPES = [
  "text",
  "structured",
  "image",
  "audio",
  "file",
  "reasoning",
  "tool_call",
  "tool_result",
] as const;

/** One message in a conversation. */
export interface Message {
  readonly role: MessageRole;
  readonly content: readonly ContentPart[];
  /** Sender display name, when the conversation distinguishes participants. */
  readonly name: string | null;
  readonly metadata: AiCoreMetadata;
}

/** Builds a text message, rejecting an over-long content array. */
export function textMessage(role: MessageRole, text: string, name: string | null = null): Message {
  return Object.freeze({
    role,
    content: Object.freeze([{ type: "text", text } satisfies TextContent]),
    name,
    metadata: Object.freeze({}),
  });
}

/** Builds a message from explicit parts, enforcing the per-message part limit. */
export function createMessage(
  role: MessageRole,
  content: readonly ContentPart[],
  name: string | null = null,
): Message {
  if (content.length > MAX_CONTENT_PARTS) {
    throw new RangeError(`message content exceeds ${MAX_CONTENT_PARTS} parts`);
  }
  return Object.freeze({
    role,
    content: Object.freeze([...content]),
    name,
    metadata: Object.freeze({}),
  });
}

/** The concatenated text of a message, in part order. Non-text parts contribute nothing. */
export function messageText(message: Message): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Every tool call requested by a message. */
export function messageToolCalls(message: Message): readonly ToolCallRequest[] {
  return message.content.flatMap((part) => (part.type === "tool_call" ? [part.call] : []));
}

/** Why a model stopped generating. */
export const STOP_REASONS = [
  "stop",
  "length",
  "tool_calls",
  "content_policy",
  "cancelled",
  "error",
  "unknown",
] as const;

/** Why generation stopped. */
export type StopReason = (typeof STOP_REASONS)[number];

/** True when the stop reason means the output is incomplete rather than finished. */
export function isIncompleteStopReason(reason: StopReason): boolean {
  return reason === "length" || reason === "cancelled" || reason === "error";
}

/**
 * Measured consumption for one model invocation.
 *
 * Every field is required, with `0` meaning "none" and `costMicro` using `null` for
 * "unpriced". Optional counters would make `usage.inputTokens + usage.outputTokens`
 * a `NaN` generator at every aggregation site.
 */
export interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly requests: number;
  /** Integer micro-USD, or `null` when the model's pricing is unknown. */
  readonly costMicro: number | null;
}

/** A zero-usage summary, used when a call produced no measurable consumption. */
export const EMPTY_USAGE: UsageSummary = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  requests: 0,
  costMicro: null,
});

/** Adds two usage summaries. Cost stays `null` if either side is unpriced. */
export function addUsage(left: UsageSummary, right: UsageSummary): UsageSummary {
  const costMicro =
    left.costMicro === null || right.costMicro === null ? null : left.costMicro + right.costMicro;
  const inputTokens = left.inputTokens + right.inputTokens;
  const outputTokens = left.outputTokens + right.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    requests: left.requests + right.requests,
    costMicro,
  };
}

/** A tool as advertised to a model. A projection of the registered descriptor — no permissions, no handler. */
export interface ModelToolSpec {
  readonly toolId: ToolId;
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
}

/** One tool call requested by a model response. */
export interface ToolCallRequest {
  /** Provider-assigned call identifier, echoed back with the result. */
  readonly callId: string;
  readonly toolId: ToolId | null;
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

/** The outcome of one tool call, normalized for return to the model. */
export type ToolCallResponse =
  | {
      readonly callId: string;
      readonly status: "succeeded";
      readonly value: JsonValue;
      /** True when the value was truncated to fit the request's output limits. */
      readonly truncated: boolean;
    }
  | {
      readonly callId: string;
      readonly status: "failed";
      /** Stable failure class, never a stack trace: this text is sent back to a model. */
      readonly errorCode: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/** A fully-resolved model invocation request, ready for a provider adapter. */
export interface ModelRequest {
  readonly modelId: ModelId;
  readonly providerId: ProviderId;
  /** Vendor-facing model name; adapters must not have to consult the registry. */
  readonly providerModelName: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ModelToolSpec[];
  readonly parameters: ModelParameters;
  readonly streaming: boolean;
  readonly metadata: AiCoreMetadata;
}

/** A normalized model invocation response. */
export interface ModelResponse {
  readonly modelId: ModelId;
  readonly providerId: ProviderId;
  readonly message: Message;
  readonly stopReason: StopReason;
  readonly usage: UsageSummary;
  readonly latencyMs: number;
  /** True when the response arrived as a stream that has now completed. */
  readonly streamed: boolean;
  /**
   * Provider-specific extras worth keeping, already normalized and redacted.
   *
   * `null` rather than `{}` when there are none, so an audit row can distinguish
   * "provider returned nothing extra" from "we chose to keep something".
   */
  readonly providerDetails: AiCoreMetadata | null;
  readonly servedAt: string;
}

/** One chunk of a streaming model response. */
export type ModelStreamEvent =
  | { readonly type: "started"; readonly modelId: ModelId; readonly providerId: ProviderId }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: ToolCallRequest }
  | { readonly type: "usage"; readonly usage: UsageSummary }
  | { readonly type: "completed"; readonly stopReason: StopReason; readonly latencyMs: number }
  | {
      readonly type: "failed";
      readonly errorCode: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/** The `type` discriminants of {@link ModelStreamEvent}. */
export const MODEL_STREAM_EVENT_TYPES = [
  "started",
  "delta",
  "reasoning_delta",
  "tool_call",
  "usage",
  "completed",
  "failed",
] as const;
