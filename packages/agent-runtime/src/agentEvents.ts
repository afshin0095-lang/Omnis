/**
 * Publishing what an agent run did, as `ai.*` events.
 *
 * AN EVENT IS A NOTIFICATION, NOT PART OF THE OUTCOME
 * ---------------------------------------------------
 * A run that succeeded must not be reported as failed because an event bus was
 * down, and an operator's `pause` must not throw because a subscriber is slow. So
 * a publish failure never changes a result.
 *
 * That is not a licence to drop events silently. Every failure is recorded and
 * countable through {@link AgentEventPublisher.publishFailures}, and an
 * `onPublishError` callback lets a composition root route it to a log or a metric.
 * "Best effort" describes the effect on the run, not the effect on the truth: an
 * observability gap that cannot be observed is how a platform loses a day of audit
 * trail and finds out a week later.
 *
 * WHERE PUBLISHING HAPPENS
 * ------------------------
 * Inside kernel hooks for anything the kernel drives, so the kernel's own
 * hook-error handling also applies, and directly for the moves the runtime makes
 * itself (instance creation, pause, resume, cancel).
 *
 * WHAT IS NEVER IN A PAYLOAD
 * --------------------------
 * Identifiers, counters, classifications and platform-generated reasons. No goal
 * text, no step input, no model output, no tool arguments: the payload schemas in
 * `@omnis/events` refuse those keys, and a broadcast stream is the wrong place for
 * the most sensitive data in the system.
 */

import { createEvent } from "@omnis/contracts";
import type { EventEnvelope, ServiceName } from "@omnis/contracts";
import { AI_EVENT_TYPES, EVENT_OWNERS } from "@omnis/events";
import type { JsonObject } from "@omnis/types";
import type { TenantId } from "@omnis/types";
import type {
  AgentId,
  AgentStateName,
  ExecutionAttempt,
  ExecutionFailure,
  ExecutionId,
  ExecutionStep,
  UsageSummary,
} from "@omnis/ai-core-types";
import { isOmnisError } from "@omnis/errors";
import type { EventBus } from "@omnis/events";

/** What one publish attempt failed on. */
export interface AgentEventPublishFailure {
  readonly type: string;
  readonly message: string;
  readonly at: string;
}

/** The facts behind one `ai.agent.state.changed` event. */
export interface AgentStateChangeFact {
  readonly executionId: ExecutionId | null;
  readonly agentId: AgentId;
  readonly from: AgentStateName;
  readonly to: AgentStateName;
  readonly waitingOn: "tool_result" | "approval" | "model_response" | null;
  readonly reason: string | null;
  readonly changedAt: string;
}

/** How a publisher is configured. */
export interface AgentEventPublisherOptions {
  readonly bus: EventBus;
  /**
   * The tenant events are published under when a run has none of its own.
   *
   * An envelope requires a tenant, and a runtime cannot invent one: publishing
   * platform work under a made-up tenant would put it in somebody's audit view, or
   * in nobody's.
   */
  readonly tenantId: TenantId;
  readonly source?: ServiceName;
  /** Called when a publish fails. Never able to change the run's outcome. */
  readonly onPublishError?: ((type: string, error: unknown) => void) | null;
  /** How many publish failures to keep. Bounded, because this list outlives runs. */
  readonly maxFailures?: number;
}

/** The publisher's surface. */
export interface AgentEventPublisher {
  /** Publishes one agent state change. */
  stateChanged(fact: AgentStateChangeFact): void;
  /** Publishes one succeeded step. */
  stepCompleted(
    executionId: ExecutionId,
    agentId: AgentId,
    step: ExecutionStep,
    attempt: ExecutionAttempt,
  ): void;
  /** Publishes one failed or skipped step. */
  stepFailed(
    executionId: ExecutionId,
    agentId: AgentId,
    step: ExecutionStep,
    attempt: ExecutionAttempt,
  ): void;
  /** Publish failures so far, oldest first. */
  publishFailures(): readonly AgentEventPublishFailure[];
}

/**
 * Wraps a publisher so that nothing it does can fail a run.
 *
 * {@link createAgentEventPublisher} already contains its own failures, but the publisher
 * is an interface anybody can implement, and a runtime that let a throwing implementation
 * abort an execution would make an outage of the event bus look like an outage of the
 * agent. The kernel holds the same rule for its hooks: an observer must never be able to
 * fail production work. Failures are kept here, bounded, and reported next to whatever the
 * wrapped publisher reports about itself.
 */
export function guardAgentEventPublisher(
  publisher: AgentEventPublisher,
  maxFailures: number = 64,
): AgentEventPublisher {
  const limit = Math.max(1, Math.trunc(maxFailures));
  const failures: AgentEventPublishFailure[] = [];

  const record = (type: string, error: unknown): void => {
    failures.push({
      type,
      message: isOmnisError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
      at: new Date().toISOString(),
    });
    if (failures.length > limit) {
      failures.splice(0, failures.length - limit);
    }
  };

  const attempt = (type: string, publish: () => void): void => {
    try {
      publish();
    } catch (error) {
      record(type, error);
    }
  };

  return {
    stateChanged(fact: AgentStateChangeFact): void {
      attempt(AI_EVENT_TYPES.agentStateChanged, () => publisher.stateChanged(fact));
    },
    stepCompleted(
      executionId: ExecutionId,
      agentId: AgentId,
      step: ExecutionStep,
      attemptRecord: ExecutionAttempt,
    ): void {
      attempt(AI_EVENT_TYPES.agentStepCompleted, () =>
        publisher.stepCompleted(executionId, agentId, step, attemptRecord),
      );
    },
    stepFailed(
      executionId: ExecutionId,
      agentId: AgentId,
      step: ExecutionStep,
      attemptRecord: ExecutionAttempt,
    ): void {
      attempt(AI_EVENT_TYPES.agentStepFailed, () =>
        publisher.stepFailed(executionId, agentId, step, attemptRecord),
      );
    },
    publishFailures(): readonly AgentEventPublishFailure[] {
      let own: readonly AgentEventPublishFailure[] = [];
      try {
        own = publisher.publishFailures();
      } catch (error) {
        record("publishFailures", error);
      }
      return Object.freeze([...failures, ...own]);
    },
  };
}

/** A publisher that publishes nothing, for a runtime wired without a bus. */
export const NOOP_AGENT_EVENT_PUBLISHER: AgentEventPublisher = Object.freeze({
  stateChanged(): void {},
  stepCompleted(): void {},
  stepFailed(): void {},
  publishFailures(): readonly AgentEventPublishFailure[] {
    return Object.freeze([]);
  },
});

/** The usage fields every step payload carries. */
function usagePayload(usage: UsageSummary): JsonObject {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costMicroUsd: usage.costMicro,
  };
}

/** The classification fields every failure payload carries. */
function failurePayload(failure: ExecutionFailure | null): JsonObject {
  return {
    errorCode: failure?.code ?? "unknown",
    failureClass: failure?.class ?? "unknown",
    errorMessage: failure?.message ?? "the step failed without a recorded reason",
    retryable: failure?.retryable ?? false,
  };
}

/** Creates a publisher over one bus. */
export function createAgentEventPublisher(
  options: AgentEventPublisherOptions,
): AgentEventPublisher {
  const source = options.source ?? EVENT_OWNERS.aiCore;
  const maxFailures = Math.max(1, Math.trunc(options.maxFailures ?? 64));
  const failures: AgentEventPublishFailure[] = [];

  const publish = (
    type: (typeof AI_EVENT_TYPES)[keyof typeof AI_EVENT_TYPES],
    payload: JsonObject,
    tenantId: TenantId | null,
  ): void => {
    try {
      const envelope: EventEnvelope = createEvent({
        type,
        payload,
        source,
        tenantId: tenantId ?? options.tenantId,
      });
      const published = options.bus.publish(envelope);
      // The reference bus is asynchronous; a publisher that ignored the promise
      // would turn a rejection into an unhandled one, which is a silent failure.
      if (published instanceof Promise) {
        published.catch((error: unknown) => record(String(type), error));
      }
    } catch (error) {
      record(String(type), error);
    }
  };

  const record = (type: string, error: unknown): void => {
    failures.push({
      type,
      message: isOmnisError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
      at: new Date().toISOString(),
    });
    if (failures.length > maxFailures) {
      failures.splice(0, failures.length - maxFailures);
    }
    options.onPublishError?.(type, error);
  };

  return {
    stateChanged(fact: AgentStateChangeFact): void {
      publish(
        AI_EVENT_TYPES.agentStateChanged,
        {
          executionId: fact.executionId === null ? null : String(fact.executionId),
          agentId: String(fact.agentId),
          from: fact.from,
          to: fact.to,
          waitingOn: fact.waitingOn,
          reason: fact.reason,
          changedAt: fact.changedAt,
        },
        null,
      );
    },

    stepCompleted(
      executionId: ExecutionId,
      agentId: AgentId,
      step: ExecutionStep,
      attempt: ExecutionAttempt,
    ): void {
      publish(
        AI_EVENT_TYPES.agentStepCompleted,
        {
          executionId: String(executionId),
          agentId: String(agentId),
          stepId: step.id,
          stepName: step.name,
          stepKind: step.kind,
          attempt: attempt.attempt,
          durationMs: attempt.durationMs ?? 0,
          ...usagePayload(attempt.usage),
        },
        null,
      );
    },

    stepFailed(
      executionId: ExecutionId,
      agentId: AgentId,
      step: ExecutionStep,
      attempt: ExecutionAttempt,
    ): void {
      publish(
        AI_EVENT_TYPES.agentStepFailed,
        {
          executionId: String(executionId),
          agentId: String(agentId),
          stepId: step.id,
          stepName: step.name,
          stepKind: step.kind,
          attempt: attempt.attempt,
          durationMs: attempt.durationMs ?? 0,
          skipped: attempt.status === "skipped",
          optional: step.optional,
          ...failurePayload(attempt.failure),
        },
        null,
      );
    },

    publishFailures(): readonly AgentEventPublishFailure[] {
      return Object.freeze([...failures]);
    },
  };
}
