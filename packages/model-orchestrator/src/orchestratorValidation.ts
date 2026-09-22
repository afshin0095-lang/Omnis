/**
 * Validation at the orchestrator's boundary, and the contracts it publishes.
 *
 * Two shapes cross into the orchestrator from callers who may be anywhere: the call request and the
 * provider attempt rows it writes into results and events. Both are schema-validated here, once, so
 * that the orchestration loop itself can assume a well-formed request and stay readable.
 *
 * The message contract is *not* re-declared as a schema. `Message` and `ContentPart` are published
 * unions in `@omnis/ai-core-types` with eight content discriminants, and a second declaration of
 * them here would be a second contract that can drift from the first. What lives here is a
 * structural guard written against the published discriminant lists, so adding a content part type
 * to the platform is a compile-time event in this file rather than a silent acceptance.
 */

import { describeSchema, identifierSchemas, jsonObjectSchema, z } from "@omnis/validation";
import { ERROR_CODE_VALUES } from "@omnis/errors";
import {
  AI_CORE_CONTRACT_VERSION,
  CONTENT_PART_TYPES,
  FAILURE_CLASSES,
  MESSAGE_ROLES,
  isModelReference,
} from "@omnis/ai-core-types";
import type { Message, ModelReference } from "@omnis/ai-core-types";
import { MAX_PROVIDER_ATTEMPTS } from "./ModelCall.js";

/** The most providers one call may report on; a bound so a bug cannot produce an unbounded row. */
export const MAX_REPORTED_ATTEMPTS = 16;

/** True when the value is structurally a {@link Message}. */
export function isMessage(value: unknown): value is Message {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<Message>;
  if (
    typeof candidate.role !== "string" ||
    !(MESSAGE_ROLES as readonly string[]).includes(candidate.role)
  ) {
    return false;
  }
  if (!Array.isArray(candidate.content)) {
    return false;
  }
  for (const part of candidate.content) {
    if (part === null || typeof part !== "object") {
      return false;
    }
    const type = (part as { readonly type?: unknown }).type;
    if (typeof type !== "string" || !(CONTENT_PART_TYPES as readonly string[]).includes(type)) {
      return false;
    }
  }
  if (
    candidate.name !== null &&
    candidate.name !== undefined &&
    typeof candidate.name !== "string"
  ) {
    return false;
  }
  return (
    candidate.metadata === null ||
    candidate.metadata === undefined ||
    typeof candidate.metadata === "object"
  );
}

/** True when the value is a conversation the orchestrator can send. */
export function isMessageList(value: unknown): value is readonly Message[] {
  return Array.isArray(value) && value.length > 0 && value.every(isMessage);
}

/** A model reference, checked by the guard published next to the union it describes. */
export const modelReferenceSchema = z.custom<ModelReference>(
  isModelReference,
  "must be a ModelReference",
);

/** A conversation. */
export const messagesSchema = z.custom<readonly Message[]>(
  isMessageList,
  "must be a non-empty array of Message",
);

/** A non-negative integer count. */
const countSchema = z.number().int().min(0);

/** The most tools one call may declare. A bound, so a request cannot carry an unbounded payload. */
export const MAX_TOOLS_PER_CALL = 64;

/** The closed parameter schema a tool spec carries, as published in `@omnis/ai-core-types`. */
const toolParameterSchemaShape = z
  .object({
    kind: z.literal("object"),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()),
  })
  .passthrough();

/** A positive duration in milliseconds, or null when unbounded. */
const durationSchema = z.number().int().min(1).nullable();

/** One call request. */
export const modelCallRequestSchema = z.strictObject({
  model: modelReferenceSchema,
  messages: messagesSchema,
  tools: z
    .array(
      z
        .object({
          toolId: identifierSchemas.tool,
          name: z.string().min(1).max(128),
          description: z.string().max(4_000),
          parameters: toolParameterSchemaShape,
        })
        .passthrough(),
    )
    .max(MAX_TOOLS_PER_CALL)
    .optional(),
  parameters: z
    .object({
      temperature: z.number().min(0).max(2).nullable().optional(),
      topP: z.number().min(0).max(1).nullable().optional(),
      maxOutputTokens: countSchema.nullable().optional(),
      stop: z.array(z.string()).optional(),
      seed: countSchema.nullable().optional(),
      responseFormat: z
        .union([
          z.object({ type: z.literal("text") }),
          z.object({ type: z.literal("json_object") }),
          z.object({ type: z.literal("json_schema") }).passthrough(),
        ])
        .nullable()
        .optional(),
    })
    .optional(),
  streaming: z.boolean().optional(),
  executionId: identifierSchemas.execution.nullable().optional(),
  correlationId: identifierSchemas.correlation.nullable().optional(),
  tenantId: identifierSchemas.tenant.nullable().optional(),
  agentId: identifierSchemas.agent.nullable().optional(),
  policyIds: z.array(z.string().min(1)).max(16).optional(),
  budgetId: identifierSchemas.budget.nullable().optional(),
  approval: z
    .object({
      approved: z.boolean(),
      approver: z.string().nullable(),
      approvedAt: z.string().datetime().nullable(),
    })
    .nullable()
    .optional(),
  deadlineMs: durationSchema.optional(),
  timeoutMs: durationSchema.optional(),
  maxAttemptsPerProvider: z.number().int().min(1).max(MAX_PROVIDER_ATTEMPTS).optional(),
  maxProviders: z.number().int().min(1).max(MAX_REPORTED_ATTEMPTS).optional(),
  requiredCapabilities: z.array(z.string().min(1)).max(16).optional(),
  metadata: jsonObjectSchema.optional(),
});

/** One provider attempt row. */
export const providerAttemptSchema = z.strictObject({
  providerId: identifierSchemas.provider,
  modelId: identifierSchemas.model,
  fallbackDepth: countSchema,
  attempt: z.number().int().min(1).max(MAX_PROVIDER_ATTEMPTS),
  status: z.enum(["succeeded", "failed", "skipped"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  latencyMs: countSchema,
  streamed: z.boolean(),
  usage: z.strictObject({
    inputTokens: countSchema,
    outputTokens: countSchema,
    totalTokens: countSchema,
    cachedInputTokens: countSchema,
    reasoningTokens: countSchema,
    requests: countSchema,
    costMicro: countSchema.nullable(),
  }),
  failure: z
    .strictObject({
      class: z.enum(FAILURE_CLASSES),
      code: z.enum(ERROR_CODE_VALUES),
      message: z.string(),
      retryable: z.boolean(),
      retryAfterMs: countSchema.nullable(),
      attempt: z.number().int().min(1),
      stepId: z.string().min(1).nullable(),
      executionId: identifierSchemas.execution.nullable(),
      modelId: identifierSchemas.model.nullable(),
      providerId: identifierSchemas.provider.nullable(),
      toolId: identifierSchemas.tool.nullable(),
      details: jsonObjectSchema,
      occurredAt: z.string().datetime(),
    })
    .nullable(),
});

/** The call request contract. */
export const MODEL_CALL_REQUEST_CONTRACT = describeSchema(
  "ModelCallRequest",
  modelCallRequestSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The provider attempt contract. */
export const PROVIDER_ATTEMPT_CONTRACT = describeSchema(
  "ProviderAttempt",
  providerAttemptSchema,
  AI_CORE_CONTRACT_VERSION,
);
