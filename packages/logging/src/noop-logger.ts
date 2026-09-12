/**
 * The no-op logger, and why it exists.
 *
 * A no-op logger is one of the few genuinely acceptable "fake" implementations
 * (see §46 of the Sprint 0 brief): it does not pretend that something happened
 * when it did not, it simply declines to record anything. It is the correct
 * default for unit tests that exercise logic which happens to log, and for
 * embedding OMNIS packages in a host application that supplies its own logger.
 *
 * It is **not** a substitute for a real sink in a running service. A service that
 * silently discards logs is a service that cannot be debugged, so
 * `createLogger()` defaults to a discard sink only because the alternative — a
 * logger that throws when unconfigured — would break every test in the monorepo.
 * Configuration wiring is responsible for supplying a {@link ConsoleLogSink} in a
 * real process.
 */

import type { LogLevel } from "@omnis/types";
import type { LogContext } from "./context.js";
import type { Logger } from "./logger.js";

/** A logger that discards every record. */
class NoopLogger implements Logger {
  /**
   * Reports the least verbose level.
   *
   * Reporting `"error"` rather than `"debug"` means any code that checks
   * `logger.level` to decide whether to build an expensive diagnostic payload
   * will correctly skip the work.
   */
  readonly level: LogLevel = "error";

  debug(_message: string, _context?: LogContext): void {}
  info(_message: string, _context?: LogContext): void {}
  warn(_message: string, _context?: LogContext): void {}
  error(_message: string, _context?: LogContext): void {}

  child(_bindings: LogContext): Logger {
    return this;
  }

  withLevel(_level: LogLevel): Logger {
    return this;
  }
}

/** The shared no-op logger instance. Stateless, so one instance is enough. */
export const NOOP_LOGGER: Logger = new NoopLogger();

/** Type guard for the shared no-op logger. */
export function isNoopLogger(logger: Logger): boolean {
  return logger === NOOP_LOGGER;
}
