/**
 * The seam between an AI Core execution and the platform's execution contract.
 *
 * Two types are called `ExecutionContext` in this repository, and they are not the
 * same thing. `@omnis/contracts` defines the *platform envelope*: tenancy, actor,
 * environment and the correlation chain, which is what a command, an event or a log
 * record carries. This package defines the *AI Core execution context*: the envelope's
 * identity plus the things an execution needs while it runs — a deadline that can be
 * compared against a clock, a cancellation token, a priority, a nesting depth and a
 * sanitized metadata bag.
 *
 * Neither can replace the other. An envelope with a cancellation token in it could not
 * be serialized into an event; an execution context without one could not be cancelled.
 * What they need is a translation, in both directions, that loses nothing that matters:
 *
 * - {@link toContractContext} projects an execution onto an envelope, so AI Core work
 *   can be reported through the platform's commands, events and audit records without
 *   the AI Core inventing its own attribution.
 * - {@link scopeOptionsFromContract} adopts an inbound envelope, so an execution started
 *   by a command continues that command's correlation and causation chain instead of
 *   starting a new one that nobody can join back to the request.
 *
 * The environment is required rather than inferred. An execution context genuinely does
 * not know whether it is running in staging or production — that is a fact about the
 * deployment, held by the composition root — and guessing it would mean a production
 * record could be attributed to a development run because a default was convenient.
 */

import { SYSTEM_ACTOR } from "@omnis/contracts";
import type {
  ActorContext,
  ExecutionContext as ContractExecutionContext,
  TenantContext,
} from "@omnis/contracts";
import { ValidationError } from "@omnis/errors";
import type { EnvironmentName, TrimmedString, WorkspaceId } from "@omnis/types";
import type { ExecutionContext } from "./ExecutionContext.js";
import type { ScopeOptions } from "./ExecutionScope.js";

/** The contract this module speaks. Kept as a constant so a failure can name it. */
const CONTRACT_CONTEXT = "ExecutionContext@contract-bridge";

/** What a projection needs that an execution context does not carry. */
export interface ContractProjection {
  /** The deployment this execution is running in. Required: never inferred. */
  readonly environment: EnvironmentName;
  /**
   * Who originated the work.
   *
   * Defaults to the agent when the execution carries an agent identifier, and to the
   * platform's `system` actor otherwise — an attribution of "the platform did this" is
   * true in that case, and inventing a human would not be.
   */
  readonly actor?: ActorContext | null;
  /** Sub-scope within the tenant, when the caller has one. */
  readonly workspaceId?: WorkspaceId | null;
  /** Data-residency hint, recorded but not routed on. */
  readonly region?: TrimmedString | null;
}

/**
 * Projects an AI Core execution context onto the platform's execution envelope.
 *
 * Throws when the execution has no tenant: an envelope without one would describe work
 * that belongs to nobody, and every consumer of the contract — events, audit, logs —
 * isolates by tenant. Refusing is cheaper than attributing.
 */
export function toContractContext(
  context: ExecutionContext,
  projection: ContractProjection,
): ContractExecutionContext {
  if (context.tenantId === null) {
    throw new ValidationError(
      `${CONTRACT_CONTEXT}: an execution with no tenant cannot be projected onto a contract envelope`,
      {
        issues: [
          {
            path: "tenantId",
            code: "invalid_type",
            message: `a contract envelope requires a tenant, and execution ${String(context.executionId)} has none`,
            received: null,
          },
        ],
      },
    );
  }

  const tenant: TenantContext = {
    tenantId: context.tenantId,
    workspaceId: projection.workspaceId ?? null,
    region: projection.region ?? null,
  };

  return {
    executionId: context.executionId,
    correlationId: context.correlationId,
    causationId: context.causationId,
    tenant,
    actor: projection.actor ?? actorFor(context),
    environment: projection.environment,
    traceId: context.traceId,
    parentSpanId: context.parentSpanId,
    // The contract's `deadlineMs` is the allowance the execution was given, not what is
    // left of it: an envelope is a record of intent, and "30s" stays true after 29 of
    // them have passed. `remainingContractMs` below is the other number, for callers that
    // need to know how much of the allowance is still usable.
    deadlineMs: context.deadline === null ? null : context.deadline.durationMs,
  };
}

/**
 * The actor an execution implies.
 *
 * An agent execution is attributed to that agent, with no delegating human named,
 * because the AI Core does not know who authorised it: a caller that does know should
 * say so through {@link ContractProjection.actor}, and an audit trail that says "agent X
 * on behalf of user Y" is worth more than one that says "agent X" — but only when it is
 * true.
 */
export function actorFor(context: ExecutionContext): ActorContext {
  if (context.agentId !== null) {
    return { kind: "agent", id: context.agentId, onBehalfOf: null, displayName: null };
  }
  return SYSTEM_ACTOR;
}

/**
 * Milliseconds left on an envelope's deadline, measured against an execution's clock.
 *
 * The envelope carries an allowance and no instant, so this is the only way to ask "how
 * much is left?" without the caller re-deriving it — and re-deriving it is how two
 * components end up disagreeing about whether work is still allowed.
 */
export function remainingContractMs(
  contract: ContractExecutionContext,
  nowMs: number,
  startedAtMs: number,
): number | null {
  if (contract.deadlineMs === null) {
    return null;
  }
  const remaining = startedAtMs + contract.deadlineMs - nowMs;
  return remaining > 0 ? remaining : 0;
}

/**
 * Adopts an inbound envelope as the identity of a new execution scope.
 *
 * The result is {@link ScopeOptions}, not a context: opening a scope is the caller's
 * decision, and a bridge that returned a finished context would have had to invent a
 * clock, a cancellation owner and a nesting depth. Everything identity-shaped is
 * carried across unchanged, so a run started by a command is joined to that command's
 * correlation chain rather than starting a parallel one.
 */
export function scopeOptionsFromContract(contract: ContractExecutionContext): ScopeOptions {
  return {
    executionId: contract.executionId,
    correlationId: contract.correlationId,
    causationId: contract.causationId,
    tenantId: contract.tenant.tenantId,
    // Only an agent actor implies an agent execution. A human actor is recorded in the
    // metadata below, where it belongs: the AI Core's `agentId` names the agent doing the
    // work, and putting a user identifier there would make an audit trail say a human ran
    // a model call.
    agentId: contract.actor?.kind === "agent" ? contract.actor.id : null,
    requestId: null,
    traceId: contract.traceId,
    parentSpanId: contract.parentSpanId,
    deadlineMs: contract.deadlineMs,
    metadata: {
      environment: contract.environment,
      actorKind: contract.actor === null ? "unknown" : contract.actor.kind,
      ...(contract.actor?.kind === "user" ? { actorId: String(contract.actor.id) } : {}),
      ...(contract.actor?.kind === "agent" && contract.actor.onBehalfOf !== null
        ? { onBehalfOf: String(contract.actor.onBehalfOf) }
        : {}),
      ...(contract.actor?.kind === "service" ? { serviceName: String(contract.actor.name) } : {}),
      ...(contract.tenant.workspaceId === null
        ? {}
        : { workspaceId: String(contract.tenant.workspaceId) }),
      ...(contract.tenant.region === null ? {} : { region: String(contract.tenant.region) }),
    },
  };
}

/**
 * True when an execution context and an envelope describe the same run.
 *
 * The comparison is over identity only — execution, correlation, causation, tenant and
 * trace — because timing and metadata legitimately differ between the two shapes. It
 * exists so a caller that projects and then adopts can check it got back the run it
 * started with, which is the mistake this bridge makes possible.
 */
export function isSameRun(context: ExecutionContext, contract: ContractExecutionContext): boolean {
  return (
    String(context.executionId) === String(contract.executionId) &&
    String(context.correlationId) === String(contract.correlationId) &&
    String(context.causationId ?? "") === String(contract.causationId ?? "") &&
    String(context.tenantId ?? "") === String(contract.tenant.tenantId) &&
    String(context.traceId ?? "") === String(contract.traceId ?? "") &&
    String(context.parentSpanId ?? "") === String(contract.parentSpanId ?? "")
  );
}
