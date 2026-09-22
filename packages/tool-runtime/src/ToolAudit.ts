/**
 * Audit records and where they go.
 *
 * The runtime produces a {@link ToolAuditRecord} for **every** invocation, including the ones it
 * refused. A denial that leaves no trace is indistinguishable from a call that never happened,
 * and "did the agent try to delete the database?" is exactly the question an audit trail exists
 * to answer.
 *
 * Storage is not the runtime's job, so records are handed to an {@link AuditSink}. The default
 * sink drops them, which is the right default for a library and the wrong one for a deployment —
 * the composition root supplies a real sink, and the health checker treats a runtime built
 * without one as a configuration question rather than a bug.
 */

import type {
  CorrelationId,
  ExecutionId,
  ToolAuditRecord,
  ToolId,
  ToolResult,
} from "@omnis/ai-core-types";

/** What the runtime needs to build a record. */
export interface ToolAuditInput {
  readonly executionId: ExecutionId;
  readonly correlationId: CorrelationId;
  readonly toolId: ToolId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly attempt: number;
  readonly permissionsRequired: readonly string[];
  readonly policyDecisionOutcome: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Argument keys only. Never values. */
  readonly argumentKeys: readonly string[];
}

/** Builds a frozen audit record. */
export function toolAuditRecord(input: ToolAuditInput): ToolAuditRecord {
  return Object.freeze({
    executionId: input.executionId,
    correlationId: input.correlationId,
    toolId: input.toolId,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    attempt: input.attempt,
    permissionsRequired: Object.freeze([...input.permissionsRequired]),
    policyDecisionOutcome: input.policyDecisionOutcome,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    timedOut: input.timedOut,
    cancelled: input.cancelled,
    argumentKeys: Object.freeze([...input.argumentKeys]),
  });
}

/** Receives audit records. Implementations must not throw into the invocation path. */
export interface AuditSink {
  record(audit: ToolAuditRecord, result: ToolResult): void;
}

/** A sink that keeps nothing. The default, and the reason a composition root supplies one. */
export const NOOP_AUDIT_SINK: AuditSink = Object.freeze({
  record(): void {
    // Deliberately empty.
  },
});

/** A sink and the records it collected. */
export interface CollectingAuditSink extends AuditSink {
  readonly records: readonly ToolAuditRecord[];
  readonly results: readonly ToolResult[];
  clear(): void;
}

/** A sink that keeps records in memory, for tests and for the Studio's inspector. */
export function createCollectingAuditSink(limit = 1_000): CollectingAuditSink {
  const records: ToolAuditRecord[] = [];
  const results: ToolResult[] = [];

  return {
    record(audit: ToolAuditRecord, result: ToolResult): void {
      records.push(audit);
      results.push(result);
      // Bounded so a long-running process with an in-memory sink cannot grow without limit.
      if (records.length > limit) {
        records.shift();
        results.shift();
      }
    },
    get records(): readonly ToolAuditRecord[] {
      return records;
    },
    get results(): readonly ToolResult[] {
      return results;
    },
    clear(): void {
      records.length = 0;
      results.length = 0;
    },
  };
}

/** A sink that forwards to several others, so audit and telemetry can share one call site. */
export function compositeAuditSink(sinks: readonly AuditSink[]): AuditSink {
  return {
    record(audit: ToolAuditRecord, result: ToolResult): void {
      for (const sink of sinks) {
        sink.record(audit, result);
      }
    },
  };
}
