/**
 * Log sinks.
 *
 * A sink is a transport: it receives an already-structured, already-redacted
 * {@link LogRecord} and writes it somewhere. Sinks deliberately contain no policy
 * — no level filtering, no redaction, no field selection — so that a new sink
 * cannot accidentally become a way to bypass a control that lives upstream.
 */

import type { LogFormat, LogLevel } from "@omnis/types";
import { LOG_LEVELS } from "@omnis/types";
import type { LogRecord } from "./context.js";
import type { LogSink } from "./logger.js";

/** The stream a record at each severity is written to. */
const STREAM_BY_LEVEL: Readonly<Record<LogLevel, "stdout" | "stderr">> = {
  debug: "stdout",
  info: "stdout",
  // Warnings and errors go to stderr so that a process's diagnostic output can be
  // separated from its data output by any supervisor, container runtime or shell
  // redirect, without the sink having to know anything about them.
  warn: "stderr",
  error: "stderr",
};

/** Options for {@link ConsoleLogSink}. */
export interface ConsoleLogSinkOptions {
  /** `json` emits one machine-parseable line; `pretty` is for human terminals. */
  readonly format?: LogFormat;
  /** Injectable for tests. Defaults to the real `console`. */
  readonly console?: Pick<Console, "log" | "error">;
}

/** Writes one line per record to stdout or stderr. */
export class ConsoleLogSink implements LogSink {
  private readonly format: LogFormat;
  private readonly target: Pick<Console, "log" | "error">;

  constructor(options: ConsoleLogSinkOptions = {}) {
    this.format = options.format ?? "json";
    this.target = options.console ?? console;
  }

  write(record: LogRecord): void {
    const line = this.format === "json" ? renderJson(record) : renderPretty(record);
    const stream = STREAM_BY_LEVEL[record.level];
    if (stream === "stderr") {
      this.target.error(line);
    } else {
      this.target.log(line);
    }
  }
}

/**
 * Renders a record as a single JSON line.
 *
 * Keys with a `null` value are dropped: in a structured log, "field absent" and
 * "field explicitly null" carry the same meaning, and emitting eleven nulls per
 * line multiplies storage and aggregator cost for no information. The record type
 * still guarantees the fields exist in-process.
 */
export function renderJson(record: LogRecord): string {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null) {
      continue;
    }
    if (typeof value === "object" && Object.keys(value as object).length === 0) {
      continue;
    }
    compact[key] = value;
  }
  return JSON.stringify(compact);
}

/** Renders a record as a single human-readable line. */
export function renderPretty(record: LogRecord): string {
  // `NonNullable<typeof part>` rather than `string`: the elements are branded
  // strings, and a predicate naming a supertype of the element type is rejected.
  const scope = [record.service, record.environment].filter(
    (part): part is NonNullable<typeof part> => part !== null,
  );
  const ids = [
    record.correlationId === null ? null : `correlationId=${record.correlationId}`,
    record.tenantId === null ? null : `tenantId=${record.tenantId}`,
    record.executionId === null ? null : `executionId=${record.executionId}`,
  ].filter((part): part is string => part !== null);

  const prefix = scope.length > 0 ? ` [${scope.join(" ")}]` : "";
  const suffix = ids.length > 0 ? ` {${ids.join(" ")}}` : "";
  const level = record.level.toUpperCase().padEnd(5);
  const base = `${record.timestamp} ${level}${prefix} ${record.message}${suffix}`;

  if (record.error === null) {
    return base;
  }
  const detail = typeof record.error["message"] === "string" ? record.error["message"] : "";
  const code = typeof record.error["code"] === "string" ? ` (${record.error["code"]})` : "";
  return `${base}\n  error${code}: ${detail}`;
}

/**
 * A sink that keeps records in memory.
 *
 * For tests and for local diagnostics. Bounded, because an unbounded in-memory
 * sink in a long-running process is a memory leak wearing a debugging hat.
 */
export class MemoryLogSink implements LogSink {
  private readonly records: LogRecord[] = [];
  private readonly capacity: number;

  constructor(capacity = 1000) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `MemoryLogSink capacity must be a positive integer, received ${capacity}`,
      );
    }
    this.capacity = capacity;
  }

  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) {
      // Drop the oldest: recent records are the ones being asserted on.
      this.records.splice(0, this.records.length - this.capacity);
    }
  }

  /** Every retained record, oldest first. */
  all(): readonly LogRecord[] {
    return this.records;
  }

  /** Records at or above a severity. */
  atLevel(level: LogLevel): readonly LogRecord[] {
    const threshold = LOG_LEVELS.indexOf(level);
    return this.records.filter((record) => LOG_LEVELS.indexOf(record.level) >= threshold);
  }

  /** Records whose message contains `fragment`. */
  matching(fragment: string): readonly LogRecord[] {
    return this.records.filter((record) => record.message.includes(fragment));
  }

  /** Number of retained records. */
  get length(): number {
    return this.records.length;
  }

  /** Empties the sink. */
  clear(): void {
    this.records.length = 0;
  }
}
