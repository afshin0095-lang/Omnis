/**
 * Logging vocabulary: severities, formats and threshold logic.
 *
 * WHY this lives in `@omnis/types`
 * --------------------------------
 * Both `@omnis/config` (which reads `OMNIS_LOG_LEVEL` from the environment) and
 * `@omnis/logging` (which decides whether to emit a record) need the same closed
 * set of severities. If each declared its own, the two would eventually disagree
 * — and the disagreement would only surface at runtime, as a configured level
 * that the logger silently ignores.
 *
 * Putting the vocabulary here, below both, also avoids a dependency between them:
 * configuration must not depend on the logger, and the logger must not depend on
 * configuration.
 */

/** Log severities, ordered from most to least verbose. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** One member of {@link LOG_LEVELS}. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** How a log record is rendered. */
export const LOG_FORMATS = ["json", "pretty"] as const;

/** One member of {@link LOG_FORMATS}. */
export type LogFormat = (typeof LOG_FORMATS)[number];

/** Type guard for a log level. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Type guard for a log format. */
export function isLogFormat(value: unknown): value is LogFormat {
  return typeof value === "string" && (LOG_FORMATS as readonly string[]).includes(value);
}

/**
 * Numeric severity, where a higher number is more severe.
 *
 * Index within {@link LOG_LEVELS}. Exposed because dashboards, alert rules and
 * sampled log shipping all need to compare severities, and comparing strings
 * would sort `debug` after `error` alphabetically.
 */
export function logLevelSeverity(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/**
 * True when a record at `level` should be emitted under `threshold`.
 *
 * A threshold of `"warn"` admits `warn` and `error` and drops `debug` and `info`.
 * The comparison is inclusive at the threshold, which is the universal convention
 * and the one operators expect when they set a level.
 */
export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return logLevelSeverity(level) >= logLevelSeverity(threshold);
}

/**
 * Normalises a loosely-typed level name from the environment.
 *
 * Accepts the conventional alternatives (`verbose` for `debug`, `fatal` and
 * `critical` for `error`, `trace` for `debug`) because those are what logging
 * documentation and operator habit produce. Returns `null` for anything
 * unrecognised so the caller can fail loudly rather than silently logging at the
 * wrong volume — a service stuck at `debug` in production is a cost and a
 * confidentiality incident, not a minor annoyance.
 */
export function normaliseLogLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.trim().toLowerCase()) {
    case "trace":
    case "verbose":
    case "debug":
      return "debug";
    case "info":
    case "information":
    case "notice":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "error":
    case "fatal":
    case "critical":
    case "severe":
      return "error";
    default:
      return null;
  }
}
