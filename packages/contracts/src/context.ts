/**
 * Execution context: who is acting, for which tenant, in which trace.
 *
 * WHY these three types are separate
 * ----------------------------------
 * They answer three different questions and change at three different rates:
 *
 * - {@link TenantContext} — *whose data is this?* Determines isolation, data
 *   residency and which platform accounts may be touched.
 * - {@link ActorContext} — *who decided to do this?* Determines authorization and
 *   audit attribution. A discriminated union, because the answer genuinely
 *   differs by kind: a human actor always has a `UserId`, an agent may be acting
 *   on a human's behalf, a service has no personal identity, and `system` has no
 *   identity at all.
 * - {@link ExecutionContext} — *which run is this part of?* Carries the
 *   correlation and causation chain plus trace identifiers, and is what makes a
 *   multi-service operation debuggable end to end.
 *
 * Keeping them separate means a repository can require tenancy without requiring
 * an actor, and a background job can carry an execution context with a `system`
 * actor, without either having to fake the other.
 *
 * INVARIANT
 * ---------
 * Every event, command, log record and span produced inside an execution carries
 * that execution's `tenantId` and `correlationId`. There is no code path that
 * produces an unattributed record. See docs/03-contracts/IDENTIFIERS.md.
 */

import {
  isProduction,
  type AgentId,
  type CausationId,
  type CorrelationId,
  type EnvironmentName,
  type ExecutionId,
  type SpanId,
  type TenantId,
  type TraceId,
  type TrimmedString,
  type UserId,
  type WorkspaceId,
} from "@omnis/types";
import {
  environmentSchema,
  causationIdSchema,
  identifierSchemas,
  serviceNameSchema,
  trimmedStringSchema,
  validate,
  z,
} from "@omnis/validation";
import { CONTRACT_VERSION } from "./version.js";

/**
 * The logical name of an OMNIS service, e.g. `content-factory` or
 * `audience-intelligence.ingestion`.
 *
 * An alias for {@link TrimmedString} rather than a distinct brand: the *format*
 * is what matters and it is enforced by {@link serviceNameSchema} at every
 * boundary an envelope crosses. Introducing a brand here would add a nominal
 * distinction with no corresponding invariant, and `pipe`-ing into a fresh
 * `z.string()` would discard the brand the trimmed-string parser already
 * established.
 */
export type ServiceName = TrimmedString;

// The format rule lives in `@omnis/validation` alongside the other primitive
// schemas. It is imported *and* re-exported here — a bare `export ... from` would
// not create a local binding, and `actorContextSchema` below needs one — because a
// service name is part of the execution context contract and consumers of this
// package should not need a second import.
export { serviceNameSchema };

// --- Tenant ----------------------------------------------------------------

/** Tenancy scope attached to every operation. */
export type TenantContext = {
  /** The owning tenant. Always present; OMNIS has no untenanted data. */
  readonly tenantId: TenantId;
  /** Optional sub-scope within the tenant. */
  readonly workspaceId: WorkspaceId | null;
  /**
   * Data-residency hint, e.g. `"eu-central"`.
   *
   * Advisory in Sprint 0: it is recorded so that residency enforcement can be
   * added later without a contract change, but nothing routes on it yet.
   */
  readonly region: TrimmedString | null;
};

/** Schema for {@link TenantContext}. */
export const tenantContextSchema = z.object({
  tenantId: identifierSchemas.tenant,
  workspaceId: identifierSchemas.workspace.nullable().default(null),
  region: trimmedStringSchema.nullable().default(null),
});

/** Validates an unknown value as a {@link TenantContext}. */
export function parseTenantContext(input: unknown): TenantContext {
  return validate(tenantContextSchema, input, `TenantContext@${CONTRACT_VERSION}`);
}

// --- Actor -----------------------------------------------------------------

/** The kinds of principal that can originate an OMNIS action. */
export const ACTOR_KINDS = ["user", "agent", "service", "system"] as const;

/** One member of {@link ACTOR_KINDS}. */
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * Who originated an action.
 *
 * A discriminated union rather than a bag of optional fields, because "which of
 * these identifiers is present" is exactly what authorization and audit need to
 * know, and optional-field bags let an invalid combination (`kind: "system"` with
 * a `UserId`) typecheck.
 */
export type ActorContext =
  | {
      /** A human principal. */
      readonly kind: "user";
      readonly id: UserId;
      readonly displayName: TrimmedString | null;
    }
  | {
      /** An autonomous agent, possibly acting on a human's behalf. */
      readonly kind: "agent";
      readonly id: AgentId;
      /**
       * The human who delegated this authority, when there is one.
       *
       * Recorded separately from `id` so an audit trail can distinguish "agent X
       * decided this" from "agent X decided this because user Y authorised it".
       * Approval gates (§62 of the architecture) read this field.
       */
      readonly onBehalfOf: UserId | null;
      readonly displayName: TrimmedString | null;
    }
  | {
      /** An OMNIS service acting on its own behalf. */
      readonly kind: "service";
      readonly name: ServiceName;
    }
  | {
      /** The platform itself: schedulers, migrations, startup. */
      readonly kind: "system";
    };

/** Schema for {@link ActorContext}. */
export const actorContextSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    id: identifierSchemas.user,
    displayName: trimmedStringSchema.nullable().default(null),
  }),
  z.object({
    kind: z.literal("agent"),
    id: identifierSchemas.agent,
    onBehalfOf: identifierSchemas.user.nullable().default(null),
    displayName: trimmedStringSchema.nullable().default(null),
  }),
  z.object({
    kind: z.literal("service"),
    name: serviceNameSchema,
  }),
  z.object({
    kind: z.literal("system"),
  }),
]);

/** Validates an unknown value as an {@link ActorContext}. */
export function parseActorContext(input: unknown): ActorContext {
  return validate(actorContextSchema, input, `ActorContext@${CONTRACT_VERSION}`);
}

/** A service actor, the most common case for background and pipeline work. */
export function serviceActor(name: ServiceName): ActorContext {
  return { kind: "service", name };
}

/** The platform actor, for schedulers, migrations and startup. */
export const SYSTEM_ACTOR: ActorContext = { kind: "system" };

/** True when the actor is a human. */
export function isHumanActor(actor: ActorContext): boolean {
  return actor.kind === "user";
}

/**
 * True when the action is autonomous — i.e. no human originated it directly.
 *
 * This is the predicate that policy engines use to decide whether an approval
 * gate applies. Autonomous actions are not forbidden; they are the point of
 * OMNIS. They are simply the ones that must be able to require a human signature
 * before a high-impact operation such as publishing or spending money.
 */
export function isAutonomousActor(actor: ActorContext): boolean {
  return actor.kind === "agent" || actor.kind === "service" || actor.kind === "system";
}

// --- Execution -------------------------------------------------------------

/** Everything needed to place one unit of work in a distributed trace. */
export type ExecutionContext = {
  /** This run's own identifier. */
  readonly executionId: ExecutionId;
  /**
   * Ties every record produced by one end-to-end business operation together.
   *
   * A single "produce and publish a video" operation spans many executions; they
   * all share one `correlationId`.
   */
  readonly correlationId: CorrelationId;
  /**
   * The specific command or event that directly caused this execution, or `null`
   * when this execution is the origin of the chain.
   *
   * `correlationId` answers "which business operation?"; `causationId` answers
   * "which immediate trigger?". Both are needed to reconstruct a causal graph
   * rather than just a flat list.
   */
  readonly causationId: CausationId | null;
  readonly tenant: TenantContext;
  /** `null` only for the rare record produced before an actor is known. */
  readonly actor: ActorContext | null;
  readonly environment: EnvironmentName;
  readonly traceId: TraceId | null;
  readonly parentSpanId: SpanId | null;
  /**
   * Deadline for the whole execution, in milliseconds.
   *
   * `null` means no deadline was imposed. Long-running production work must set
   * one: an execution with no deadline cannot be cancelled, cannot be retried
   * safely and cannot be distinguished from a hang.
   */
  readonly deadlineMs: number | null;
};

/** Schema for {@link ExecutionContext}. */
export const executionContextSchema = z.object({
  executionId: identifierSchemas.execution,
  correlationId: identifierSchemas.correlation,
  causationId: causationIdSchema.nullable().default(null),
  tenant: tenantContextSchema,
  actor: actorContextSchema.nullable().default(null),
  environment: environmentSchema,
  traceId: identifierSchemas.trace.nullable().default(null),
  parentSpanId: identifierSchemas.span.nullable().default(null),
  deadlineMs: z.number().int().positive().nullable().default(null),
});

/** Validates an unknown value as an {@link ExecutionContext}. */
export function parseExecutionContext(input: unknown): ExecutionContext {
  return validate(executionContextSchema, input, `ExecutionContext@${CONTRACT_VERSION}`);
}

/** True when this context is running against production. */
export function isProductionContext(context: ExecutionContext): boolean {
  return isProduction(context.environment);
}
