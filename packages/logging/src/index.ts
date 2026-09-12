/**
 * `@omnis/logging` — provider-independent structured logging.
 *
 * Application code depends on {@link Logger}. Infrastructure supplies a
 * {@link LogSink}. Neither knows about the other, so the logging backend can be
 * chosen — or changed — without touching a single call site.
 *
 * Records are filtered, structured and redacted before they reach a sink, so a
 * sink is purely a transport and cannot become a way to bypass a control.
 *
 * Dependencies: `@omnis/types`, `@omnis/errors`.
 */

export { buildLogRecord, createLogger, StandardLogger } from "./logger.js";
export type { Logger, LoggerOptions, LogSink } from "./logger.js";

export { mergeLogContext } from "./context.js";
export type { LogContext, LogRecord } from "./context.js";

export { ConsoleLogSink, MemoryLogSink, renderJson, renderPretty } from "./sinks.js";
export type { ConsoleLogSinkOptions } from "./sinks.js";

export { isNoopLogger, NOOP_LOGGER } from "./noop-logger.js";
