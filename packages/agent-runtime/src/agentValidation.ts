/**
 * Runtime validation for everything the agent runtime accepts from a caller.
 *
 * An agent descriptor is a governance record: it decides which tools may run,
 * which model is preferred, what the ceilings are and which policy set applies. A
 * descriptor assembled from configuration, an API call or another service is
 * therefore untrusted input, and "the TypeScript type says so" is not a runtime
 * guarantee. Everything here is parsed before it becomes part of a durable record.
 *
 * Two rules shape the schemas:
 *
 * 1. **Closed objects.** An unknown key in a registration input is a caller
 *    believing something the runtime will silently ignore — `contraints` instead
 *    of `constraints`, say, which reads as a ceiling that was set and never
 *    applies. Stripping unknown keys hides that; refusing them surfaces it.
 * 2. **Ceilings are validated as ceilings.** A negative `maxSteps` or a
 *    fractional `maxDurationMs` is not a strange value to be clamped later, it is
 *    a caller that does not know what it asked for.
 */

import {
  AGENT_CAPABILITIES,
  AGENT_KINDS,
  AGENT_MEMORY_KINDS,
  AGENT_STATUSES,
  EXECUTION_KINDS,
} from "@omnis/ai-core-types";
import type {
  AgentCapability,
  AgentId,
  AgentKind,
  AgentMemoryKind,
  AgentStatus,
  BudgetId,
  ExecutionKind,
  ModelReference,
  PolicyId,
  ToolId,
  ToolReference,
  ToolRiskLevel,
} from "@omnis/ai-core-types";
import type { JsonValue } from "@omnis/types";
import {
  identifierSchemas,
  isoDateTimeSchema,
  jsonObjectSchema,
  nonEmptyStringSchema,
  semVerSchema,
  trimmedStringSchema,
  z,
} from "@omnis/validation";
import { modelReferenceSchema, toolReferenceSchema } from "@omnis/execution-kernel";

/**
 * A model reference where one is required.
 *
 * The kernel's schema accepts `null`, because an execution request legitimately
 * names no model. A preference list entry that is `null` is not "no preference", it
 * is a caller that built the list wrong, and `preferredModelOf` would hand the
 * runtime a reference it cannot resolve.
 */
const requiredModelReferenceSchema = modelReferenceSchema.refine(
  (value): value is ModelReference => value !== null,
  {
    message: "must name a model",
  },
);

/** A non-negative integer, the shape every counter and ceiling in this package uses. */
const countSchema = z.number().int().nonnegative();

/**
 * A trimmed string within a length range.
 *
 * `trimmedStringSchema` is a custom schema and carries no length methods, so a
 * bounded identifier is built here rather than validated after the fact: a slug
 * that is 40 000 characters long is a caller mistake, and the registry is the
 * wrong place to discover it.
 *
 * Padding is trimmed rather than refused, which is what every branded string in
 * OMNIS does. The consequence — `"assistant "` and `"assistant"` are the same
 * agent — is asserted by the registry tests rather than left to be discovered.
 */
function boundedText(min: number, max: number) {
  return z.string().trim().min(min).max(max);
}

/** A positive integer, for a ceiling that must actually bound something. */
const positiveIntSchema = z.number().int().positive();

/** How an agent's instructions are supplied at registration. */
export const agentInstructionsInputSchema = z
  .object({
    system: trimmedStringSchema.optional(),
    developer: trimmedStringSchema.nullable().optional(),
    prohibitions: z.array(trimmedStringSchema).max(64).optional(),
  })
  .strict();

/** How one tool binding is supplied at registration. */
export const agentToolBindingInputSchema = z
  .object({
    toolId: identifierSchemas.tool,
    timeoutMsOverride: positiveIntSchema.nullable().optional(),
    maxCallsPerExecution: countSchema.optional(),
    required: z.boolean().optional(),
  })
  .strict();

/** How a memory reference is supplied at registration. */
export const agentMemoryReferenceSchema = z
  .object({
    kind: z.enum(AGENT_MEMORY_KINDS),
    storeId: nonEmptyStringSchema,
    scope: trimmedStringSchema.nullable().optional(),
    writable: z.boolean().optional(),
  })
  .strict();

/** How an agent's ceilings are supplied at registration. */
export const agentConstraintsInputSchema = z
  .object({
    maxSteps: positiveIntSchema.nullable().optional(),
    maxModelCalls: positiveIntSchema.nullable().optional(),
    maxToolCalls: positiveIntSchema.nullable().optional(),
    maxDurationMs: positiveIntSchema.nullable().optional(),
    maxCostMicroUsd: countSchema.nullable().optional(),
    maxRetriesPerStep: countSchema.nullable().optional(),
    allowedTools: z.array(identifierSchemas.tool).max(64).optional(),
    deniedTools: z.array(identifierSchemas.tool).max(64).optional(),
    approvalRequiredAtRisk: z.array(z.enum(["low", "medium", "high", "critical"])).optional(),
    preferredModels: z.array(requiredModelReferenceSchema).max(8).optional(),
  })
  .strict();

/** An agent as supplied at registration, before defaults are applied. */
export const agentRegistrationInputSchema = z
  .object({
    id: identifierSchemas.agent.optional(),
    slug: boundedText(2, 128),
    displayName: boundedText(1, 256).optional(),
    description: z.string().max(2_048).optional(),
    kind: z.enum(AGENT_KINDS),
    status: z.enum(AGENT_STATUSES).optional(),
    version: semVerSchema.optional(),
    capabilities: z.array(z.enum(AGENT_CAPABILITIES)).max(AGENT_CAPABILITIES.length).optional(),
    instructions: agentInstructionsInputSchema.optional(),
    defaultModel: modelReferenceSchema.nullable().optional(),
    tools: z.array(agentToolBindingInputSchema).max(64).optional(),
    memory: z.array(agentMemoryReferenceSchema).max(16).optional(),
    constraints: agentConstraintsInputSchema.optional(),
    policyId: identifierSchemas.policy.nullable().optional(),
    budgetId: identifierSchemas.budget.nullable().optional(),
    metadata: jsonObjectSchema.optional(),
    createdAt: isoDateTimeSchema.optional(),
    updatedAt: isoDateTimeSchema.optional(),
  })
  .strict();

/** One step of a plan a caller supplies, before it becomes an {@link ExecutionStep}. */
export const agentPlanStepInputSchema = z
  .object({
    id: boundedText(1, 128),
    name: boundedText(1, 256).optional(),
    /**
     * The kind of work the step is.
     *
     * `agent` is refused: a step that ran another agent would make the runtime
     * recursive, and Sprint 1 has no depth bound, no cycle detection across agents
     * and no delegation policy. Refusing it here is cheaper than discovering it in
     * a budget.
     */
    kind: z.enum(EXECUTION_KINDS).refine((kind: ExecutionKind) => kind !== "agent", {
      message: "an agent step inside an agent plan is not supported",
    }),
    dependsOn: z.array(boundedText(1, 128)).max(8).optional(),
    timeoutMs: positiveIntSchema.nullable().optional(),
    maxAttempts: z.number().int().min(1).max(3).optional(),
    optional: z.boolean().optional(),
    input: jsonObjectSchema.optional(),
    /**
     * A tool step's arguments, validated by the tool runtime against the tool's schema.
     *
     * A separate field rather than a key inside `input`, because "which of these keys are
     * arguments?" is a question a plan should not have to answer: `input` also carries the
     * goal and the agent's instructions, and a tool that received those as arguments would
     * be handed data it never declared.
     */
    arguments: jsonObjectSchema.optional(),
    model: modelReferenceSchema.nullable().optional(),
    tool: toolReferenceSchema.nullable().optional(),
  })
  .strict();

/** What a caller asks an agent to do. */
export const agentRunInputSchema = z
  .object({
    /** The task, in the caller's words. Recorded, never interpreted here. */
    goal: boundedText(1, 8_192).nullable().optional(),
    /** An explicit plan. Without one, the descriptor's default model answers in a single step. */
    steps: z.array(agentPlanStepInputSchema).max(64).optional(),
    /** Structured input handed to every step that does not declare its own. */
    data: jsonObjectSchema.optional(),
  })
  .strict();

/**
 * The types a caller supplies.
 *
 * These are written by hand rather than inferred from the schemas, following the
 * house pattern in `@omnis/model-registry`: a schema's *input* type is only as
 * precise as its least precise member, and a custom branded schema (`slug`,
 * `toolId`) has an input type of `unknown`. Inferring the caller-facing type from
 * the schema would therefore type `slug` as `unknown`, which accepts anything and
 * documents nothing. The schema stays the runtime authority; the interface stays
 * the compile-time one, and the tests below assert the two agree.
 */

/** How an agent's instructions are supplied at registration. */
export interface AgentInstructionsInput {
  readonly system?: string;
  readonly developer?: string | null;
  readonly prohibitions?: readonly string[];
}

/** How one tool binding is supplied at registration. */
export interface AgentToolBindingInput {
  readonly toolId: ToolId;
  readonly timeoutMsOverride?: number | null;
  readonly maxCallsPerExecution?: number;
  readonly required?: boolean;
}

/** How a memory reference is supplied at registration. */
export interface AgentMemoryReferenceInput {
  readonly kind: AgentMemoryKind;
  readonly storeId: string;
  readonly scope?: string | null;
  readonly writable?: boolean;
}

/** How an agent's ceilings are supplied at registration. */
export interface AgentConstraintsInput {
  readonly maxSteps?: number | null;
  readonly maxModelCalls?: number | null;
  readonly maxToolCalls?: number | null;
  readonly maxDurationMs?: number | null;
  readonly maxCostMicroUsd?: number | null;
  readonly maxRetriesPerStep?: number | null;
  readonly allowedTools?: readonly ToolId[];
  readonly deniedTools?: readonly ToolId[];
  readonly approvalRequiredAtRisk?: readonly ToolRiskLevel[];
  readonly preferredModels?: readonly ModelReference[];
}

/** An agent as supplied at registration, before defaults are applied. */
export interface AgentRegistrationInput {
  readonly id?: AgentId;
  readonly slug: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly kind: AgentKind;
  /** Defaults to `draft`, which cannot run until somebody activates it. */
  readonly status?: AgentStatus;
  readonly version?: string;
  readonly capabilities?: readonly AgentCapability[];
  readonly instructions?: AgentInstructionsInput;
  readonly defaultModel?: ModelReference | null;
  readonly tools?: readonly AgentToolBindingInput[];
  readonly memory?: readonly AgentMemoryReferenceInput[];
  readonly constraints?: AgentConstraintsInput;
  readonly policyId?: PolicyId | null;
  readonly budgetId?: BudgetId | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/**
 * One step of a plan a caller supplies.
 *
 * `kind` may not be `agent`: a step that ran another agent would make the runtime
 * recursive, and Sprint 1 has no depth bound and no delegation policy. The schema
 * refuses it, and the type says so in words.
 */
export interface AgentPlanStepInput {
  readonly id: string;
  readonly name?: string;
  readonly kind: ExecutionKind;
  readonly dependsOn?: readonly string[];
  readonly timeoutMs?: number | null;
  readonly maxAttempts?: number;
  readonly optional?: boolean;
  readonly input?: Readonly<Record<string, JsonValue>>;
  /** A tool step's arguments. Ignored by a model step. */
  readonly arguments?: Readonly<Record<string, JsonValue>>;
  readonly model?: ModelReference | null;
  readonly tool?: ToolReference | null;
}

/** What a caller asks an agent to do. */
export interface AgentRunInput {
  /** The task, in the caller's words. Recorded, never interpreted here. */
  readonly goal?: string | null;
  /** An explicit plan. Without one, the descriptor's preferred model answers in a single step. */
  readonly steps?: readonly AgentPlanStepInput[];
  /** Structured input handed to every step that does not declare its own. */
  readonly data?: Readonly<Record<string, JsonValue>>;
}

/** The registration as parsed, with every default applied and every string branded. */
export type AgentRegistration = z.infer<typeof agentRegistrationInputSchema>;
/** The run input as parsed. */
export type AgentRun = z.infer<typeof agentRunInputSchema>;
/** One plan step as parsed. */
export type AgentPlanStep = z.infer<typeof agentPlanStepInputSchema>;

/** The published contract identifiers, for documentation and contract tests. */
export const AGENT_REGISTRATION_CONTRACT = "AgentRegistrationInput" as const;
export const AGENT_RUN_INPUT_CONTRACT = "AgentRunInput" as const;
export const AGENT_PLAN_STEP_CONTRACT = "AgentPlanStepInput" as const;

/** True when the value names an agent kind. */
export function isAgentKindValue(value: string): value is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(value);
}

/** True when the value names an agent status. */
export function isAgentStatusValue(value: string): value is AgentStatus {
  return (AGENT_STATUSES as readonly string[]).includes(value);
}

/** True when the value names an agent capability. */
export function isAgentCapabilityValue(value: string): value is AgentCapability {
  return (AGENT_CAPABILITIES as readonly string[]).includes(value);
}

/** True when the value names a memory kind. */
export function isAgentMemoryKindValue(value: string): value is AgentMemoryKind {
  return (AGENT_MEMORY_KINDS as readonly string[]).includes(value);
}
