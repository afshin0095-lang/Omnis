/**
 * Validation schemas for tools, invocations and results.
 *
 * A tool descriptor is a security document, so it is validated as one: timeouts must be finite
 * and positive, concurrency must be at least one, permissions must parse, and the parameter
 * schema must be closed. Every schema here is also the published contract, which is what lets an
 * audit row or an event payload be checked by a consumer that never saw the tool run.
 */

import {
  AI_CORE_CONTRACT_VERSION,
  TOOL_DENIAL_REASONS,
  TOOL_KINDS,
  TOOL_PARAMETER_TYPES,
  TOOL_PERMISSION_ACTIONS,
  TOOL_RISK_LEVELS,
  TOOL_SIDE_EFFECTS,
  TOOL_STATUSES,
} from "@omnis/ai-core-types";
import type {
  ToolDenialReason,
  ToolDescriptor,
  ToolParameterSpec,
  ToolRiskLevel,
  ToolStatus,
} from "@omnis/ai-core-types";
import {
  describeSchema,
  identifierSchemas,
  jsonObjectSchema,
  jsonValueSchema,
  nonEmptyStringSchema,
  z,
} from "@omnis/validation";

/** Maximum length of a registered tool name — the name a model is told to call. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** Longest timeout the runtime will accept: one hour. */
export const MAX_TOOL_TIMEOUT_MS = 3_600_000;

/** Highest concurrency the runtime will accept. */
export const MAX_TOOL_CONCURRENCY = 1_024;

/** A tool name: what a model emits, so it is constrained to what models reliably produce. */
export const toolNameSchema = z
  .string()
  .min(1)
  .max(MAX_TOOL_NAME_LENGTH)
  .regex(/^[a-z][a-z0-9_]*$/, {
    message: "tool name must be lowercase snake_case starting with a letter",
  });

/** Schema for a semantic version string. */
export const toolVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, {
  message: "tool version must be a semantic version",
});

/** Schema for one parameter type. */
export const toolParameterTypeSchema = z.enum(TOOL_PARAMETER_TYPES);

/**
 * Schema for one parameter declaration.
 *
 * Annotated rather than inferred because it is recursive: an `array` parameter declares its
 * element type with the same shape, and Zod cannot infer a type that refers to itself.
 */
export const toolParameterSpecSchema: z.ZodType<ToolParameterSpec> = z.lazy(() =>
  z.object({
    type: toolParameterTypeSchema,
    description: z.string().max(1024),
    enumValues: z.array(z.string().min(1).max(256)).max(256),
    items: toolParameterSpecSchema.nullable(),
    nullable: z.boolean(),
  }),
);

/** Schema for a closed parameter schema. */
export const toolParameterSchemaSchema = z.object({
  kind: z.literal("object"),
  properties: z.record(z.string(), toolParameterSpecSchema),
  required: z.array(z.string().min(1)),
});

/** Schema for one permission claim. */
export const toolPermissionSchema = z.object({
  resource: nonEmptyStringSchema,
  action: z.enum(TOOL_PERMISSION_ACTIONS),
});

/** Schema for a tool kind. */
export const toolKindSchema = z.enum(TOOL_KINDS);

/** Schema for a risk level. */
export const toolRiskLevelSchema = z.enum(TOOL_RISK_LEVELS);

/** Schema for a side-effect classification. */
export const toolSideEffectSchema = z.enum(TOOL_SIDE_EFFECTS);

/** Schema for a registration status. */
export const toolStatusSchema = z.enum(TOOL_STATUSES);

/** Schema for a denial reason. */
export const toolDenialReasonSchema = z.enum(TOOL_DENIAL_REASONS);

/** Schema for a stored descriptor. */
export const toolDescriptorSchema = z.object({
  id: identifierSchemas.tool,
  name: toolNameSchema,
  displayName: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  version: toolVersionSchema,
  kind: toolKindSchema,
  riskLevel: toolRiskLevelSchema,
  sideEffect: toolSideEffectSchema,
  permissions: z.array(toolPermissionSchema).max(64),
  parameters: toolParameterSchemaSchema,
  resultDescription: z.string().max(1024),
  timeoutMs: z.number().int().positive().max(MAX_TOOL_TIMEOUT_MS),
  supportsCancellation: z.boolean(),
  maxConcurrency: z.number().int().positive().max(MAX_TOOL_CONCURRENCY),
  requiresApproval: z.boolean(),
  policyId: identifierSchemas.policy.nullable(),
  budgetId: identifierSchemas.budget.nullable(),
  status: toolStatusSchema,
  metadata: jsonObjectSchema,
  registeredAt: z.string().datetime(),
});

/**
 * A descriptor as supplied at registration.
 *
 * The fields the registry fills in — identifier, status, registration time — and the fields that
 * are legitimately absent until an operator wires them up — policy, budget, metadata — are all
 * optional here and all present on the stored descriptor.
 */
export const toolDescriptorInputSchema = toolDescriptorSchema
  .omit({
    id: true,
    registeredAt: true,
    status: true,
    metadata: true,
    policyId: true,
    budgetId: true,
  })
  .extend({
    id: identifierSchemas.tool.optional(),
    status: toolStatusSchema.optional(),
    registeredAt: z.string().datetime().optional(),
    metadata: jsonObjectSchema.optional(),
    policyId: identifierSchemas.policy.nullish(),
    budgetId: identifierSchemas.budget.nullish(),
  });

/** Schema for the environment a handler is given. */
export const toolExecutionEnvironmentSchema = z.object({
  executionId: identifierSchemas.execution,
  correlationId: identifierSchemas.correlation,
  attempt: z.number().int().min(1),
});

/** Schema for one invocation. */
export const toolInvocationSchema = z.object({
  toolId: identifierSchemas.tool,
  name: toolNameSchema,
  arguments: jsonObjectSchema,
  environment: toolExecutionEnvironmentSchema,
  metadata: jsonObjectSchema,
});

/** Schema for an audit record. */
export const toolAuditRecordSchema = z.object({
  executionId: identifierSchemas.execution,
  correlationId: identifierSchemas.correlation,
  toolId: identifierSchemas.tool,
  toolName: toolNameSchema,
  toolVersion: toolVersionSchema,
  attempt: z.number().int().min(1),
  permissionsRequired: z.array(z.string()),
  policyDecisionOutcome: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  argumentKeys: z.array(z.string()),
});

/** Schema for a handler's pre-normalization result. */
export const toolHandlerResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: jsonValueSchema }),
  z.object({
    ok: z.literal(false),
    errorCode: nonEmptyStringSchema,
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
]);

/** Schema for a normalized result. */
export const toolResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    toolId: identifierSchemas.tool,
    value: jsonValueSchema,
    durationMs: z.number().int().min(0),
    audit: toolAuditRecordSchema,
  }),
  z.object({
    status: z.literal("failed"),
    toolId: identifierSchemas.tool,
    errorCode: nonEmptyStringSchema,
    message: z.string(),
    retryable: z.boolean(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    durationMs: z.number().int().min(0),
    audit: toolAuditRecordSchema,
  }),
  z.object({
    status: z.literal("denied"),
    toolId: identifierSchemas.tool,
    reason: toolDenialReasonSchema,
    message: z.string(),
    audit: toolAuditRecordSchema,
  }),
]);

/** The tool descriptor contract. */
export const TOOL_DESCRIPTOR_CONTRACT = describeSchema(
  "ToolDescriptor",
  toolDescriptorSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The tool result contract. */
export const TOOL_RESULT_CONTRACT = describeSchema(
  "ToolResult",
  toolResultSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The tool audit record contract. */
export const TOOL_AUDIT_CONTRACT = describeSchema(
  "ToolAuditRecord",
  toolAuditRecordSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** A descriptor as supplied at registration. Mirrors {@link toolDescriptorInputSchema}. */
export type ToolDescriptorInput = Omit<
  ToolDescriptor,
  "id" | "registeredAt" | "status" | "metadata" | "policyId" | "budgetId"
> & {
  readonly id?: ToolDescriptor["id"];
  readonly status?: ToolStatus;
  readonly registeredAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly policyId?: ToolDescriptor["policyId"];
  readonly budgetId?: ToolDescriptor["budgetId"];
};

/** True when the value is a known risk level. */
export function isToolRiskLevelValue(value: string): value is ToolRiskLevel {
  return toolRiskLevelSchema.safeParse(value).success;
}

/** True when the value is a known denial reason. */
export function isToolDenialReason(value: string): value is ToolDenialReason {
  return toolDenialReasonSchema.safeParse(value).success;
}
