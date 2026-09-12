/**
 * The provider-independent logger contract.
 *
 * WHY AN INTERFACE AND A SINK
 * ---------------------------
 * §27 requires a logger that is not tied to a vendor, and that is not an abstract
 * preference. OMNIS will eventually ship structured logs to an aggregator, and
 * which aggregator is an infrastructure decision that will change. If domain code
 * imported `pino` or `winston` directly, that decision would be embedded in
 * hundreds of call sites.
 *
 * The split is therefore:
 *
 * - {@link Logger} — what application code calls. Four severities, an optional
 *   context, and `child()` for inherited bindings. Nothing else, because a wider
 *   surface means every future sink has to implement more.
 * - {@link LogSink} — where a fully-formed {@link LogRecord} goes. This is the
 *   only extension point, and it receives an already-structured, already-redacted
 *   record, so a sink cannot accidentally bypass redaction.
 *
 * Redaction and level filtering happen **before** the sink. A sink is a transport,
 * not a policy point.
 */

import type { JsonObject } from "@omnis/types";
import { nowIso, shouldLog, type LogLevel } from "@omnis/types";
import { isOmnisError, redactObject } from "@omnis/errors";
import { mergeLogContext, type LogContext, type LogRecord } from "./context.js";

/** Receives fully-formed, redacted log records. */
export interface LogSink {
  /** Writes one record. Must not throw; a sink failure must not break the caller. */
  write(record: LogRecord): void;
  /** Releases any underlying resource. Optional. */
  flush?(): void | Promise<void>;
}

/** What application code calls. */
export interface Logger {
  /** The severity threshold currently in effect. */
  readonly level: LogLevel;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger whose records always carry `bindings`. */
  child(bindings: LogContext): Logger;
  /** Returns the same logger at a different threshold. */
  withLevel(level: LogLevel): Logger;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Severity threshold. Records below it are dropped before any formatting. */
  readonly level?: LogLevel;
  /** Where records go. Defaults to discarding them. */
  readonly sink?: LogSink;
  /** Bindings applied to every record from this logger and its children. */
  readonly context?: LogContext;
  /**
   * Include stack traces on error records.
   *
   * Off by default. A stack trace embeds absolute filesystem paths, dependency
   * versions and occasionally argument values, which is useful on a laptop and
   * inappropriate in a shared aggregator. Enable it for local debugging.
   */
  readonly includeStack?: boolean;
}

/** The standard {@link Logger} implementation. */
export class StandardLogger implements Logger {
  readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly bindings: LogContext;
  private readonly includeStack: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.sink = options.sink ?? DISCARD_SINK;
    this.bindings = options.context ?? {};
    this.includeStack = options.includeStack ?? false;
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.emit("error", message, context);
  }

  child(bindings: LogContext): Logger {
    return new StandardLogger({
      level: this.level,
      sink: this.sink,
      // Child bindings are merged over the parent's, so a request-scoped child
      // can narrow the service or add a tenant without restating the rest.
      context: mergeLogContext(this.bindings, bindings),
      includeStack: this.includeStack,
    });
  }

  withLevel(level: LogLevel): Logger {
    return new StandardLogger({
      level,
      sink: this.sink,
      context: this.bindings,
      includeStack: this.includeStack,
    });
  }

  /** Filters, builds and dispatches one record. */
  private emit(level: LogLevel, message: string, context?: LogContext): void {
    if (!shouldLog(level, this.level)) {
      return;
    }
    const merged = context === undefined ? this.bindings : mergeLogContext(this.bindings, context);
    const record = buildLogRecord(level, message, merged, this.includeStack);

    try {
      this.sink.write(record);
    } catch {
      // A sink that throws must not take down the caller. Logging is a side
      // concern: losing a record is acceptable, crashing a production request
      // because a log transport was briefly unavailable is not. The failure is
      // swallowed deliberately and this is the only place in the package that
      // does so.
    }
  }
}

/** Sink used when none is supplied. */
const DISCARD_SINK: LogSink = { write: () => undefined };

/**
 * Builds a serializable, redacted {@link LogRecord}.
 *
 * Identifiers are stringified here rather than in the sink, so every sink sees
 * exactly the same shape and no sink has to know that a `TenantId` is a branded
 * string. The error is serialized through the OMNIS error hierarchy when it is
 * one, which means its metadata was already redacted at construction and is
 * redacted again here as defence in depth.
 */
export function buildLogRecord(
  level: LogLevel,
  message: string,
  context: LogContext,
  includeStack = false,
): LogRecord {
  return {
    timestamp: nowIso(),
    level,
    message,
    service: context.service ?? null,
    environment: context.environment ?? null,
    executionId: stringify(context.executionId),
    correlationId: stringify(context.correlationId),
    causationId: stringify(context.causationId),
    tenantId: stringify(context.tenantId),
    actorId: context.actorId ?? null,
    characterId: stringify(context.characterId),
    agentId: stringify(context.agentId),
    contentId: stringify(context.contentId),
    attributes: redactObject(context.attributes ?? {}),
    error: serializeErrorForLog(context.error, includeStack),
  };
}

/** Serializes a caught value of unknown provenance for a log record. */
function serializeErrorForLog(error: unknown, includeStack: boolean): JsonObject | null {
  if (error === null || error === undefined) {
    return null;
  }
  if (isOmnisError(error)) {
    return redactObject(error.serialize({ includeStack }));
  }
  if (error instanceof Error) {
    return redactObject({
      name: error.name,
      message: error.message,
      ...(includeStack && error.stack !== undefined ? { stack: error.stack } : {}),
    });
  }
  // Anything can be thrown in JavaScript. Recording it beats dropping it.
  return redactObject({ message: String(error) });
}

/** Renders a branded identifier as a plain string, or `null` when absent. */
function stringify(value: string | undefined): string | null {
  return value === undefined ? null : String(value);
}

/** Creates a {@link StandardLogger}. */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new StandardLogger(options);
}
