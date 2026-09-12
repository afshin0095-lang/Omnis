/**
 * Stable error codes for the OMNIS error hierarchy.
 *
 * WHY stable codes
 * ----------------
 * Error *messages* are written for humans and change freely. Error *codes* are a
 * contract: dashboards, alert rules, retry policies, approval flows and client
 * applications all branch on them. Changing a code is therefore a breaking change
 * and requires an ADR (see docs/03-contracts/VERSIONING.md).
 *
 * Codes are `snake_case` strings rather than a numeric range so they remain
 * readable in a log line without a lookup table, and so a new code cannot
 * silently collide with an existing one the way an incrementing integer can.
 */

/** Every error code OMNIS may emit. */
export const ERROR_CODES = {
  /** Input violated a schema or a domain invariant. Never retryable as-is. */
  validationFailed: "validation_failed",
  /** Environment or file configuration was missing, malformed or contradictory. */
  configurationInvalid: "configuration_invalid",
  /** A referenced entity does not exist. */
  notFound: "not_found",
  /** The operation conflicts with current state (duplicate, stale version, ...). */
  conflict: "conflict",
  /** The caller could not be authenticated. */
  authenticationFailed: "authentication_failed",
  /** The caller is authenticated but not permitted to perform the operation. */
  authorizationFailed: "authorization_failed",
  /** A policy or approval gate rejected the operation. */
  policyViolation: "policy_violation",
  /** An external provider failed, rate-limited or returned unusable output. */
  providerFailure: "provider_failure",
  /** An agent, tool or pipeline execution failed. */
  executionFailed: "execution_failed",
  /** An operation exceeded its deadline. */
  timeout: "timeout",
  /** Database, queue, network, storage or another infrastructure dependency failed. */
  infrastructureFailure: "infrastructure_failure",
  /** A versioned contract was violated by a producer or consumer. */
  contractViolation: "contract_violation",
  /** A capability is declared but intentionally not implemented yet. */
  notImplemented: "not_implemented",
  /** An error occurred that does not map to any known classification. */
  unknown: "unknown",
} as const;

/** The key of an entry in {@link ERROR_CODES}, e.g. `"validationFailed"`. */
export type ErrorCodeKey = keyof typeof ERROR_CODES;

/** The wire value of an error code, e.g. `"validation_failed"`. */
export type OmnisErrorCode = (typeof ERROR_CODES)[ErrorCodeKey];

/**
 * {@link OmnisErrorCode} as a non-empty tuple, for schema libraries that need one.
 *
 * Derived from {@link ERROR_CODES} so the tuple cannot drift from the record. The
 * cast is the price of `Object.values` returning a plain array; it is confined to
 * this one line and is checked by the `satisfies`-style guarantee that every
 * member of `ERROR_CODES` is an `OmnisErrorCode`.
 */
export const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as [
  OmnisErrorCode,
  ...OmnisErrorCode[],
];

/** Reverse index from wire value to code key. */
const KEY_BY_CODE: ReadonlyMap<string, ErrorCodeKey> = new Map(
  (Object.keys(ERROR_CODES) as ErrorCodeKey[]).map((key) => [ERROR_CODES[key], key]),
);

/** Type guard for a wire error code. */
export function isOmnisErrorCode(value: unknown): value is OmnisErrorCode {
  return typeof value === "string" && KEY_BY_CODE.has(value);
}

/**
 * Whether an error carrying this code is worth retrying unchanged.
 *
 * This is the *default* classification. Individual errors may override it: a
 * provider failure caused by an invalid API key is not retryable even though
 * provider failures usually are. Callers must consult `error.retryable`, never
 * this table directly.
 */
const RETRYABLE_CODES: ReadonlySet<OmnisErrorCode> = new Set([
  ERROR_CODES.providerFailure,
  ERROR_CODES.timeout,
  ERROR_CODES.infrastructureFailure,
  ERROR_CODES.executionFailed,
]);

/** Default retryability for a code. */
export function isRetryableCode(code: OmnisErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/**
 * Suggested HTTP status for a code.
 *
 * This is a convenience for API adapters only. It is deliberately *not* the
 * source of truth for HTTP behaviour: an adapter may narrow a status based on
 * context (for example `not_found` inside a batch request becomes a per-item
 * error inside a `200` response). Domain code must never read it.
 */
const HTTP_STATUS_BY_CODE: Readonly<Record<OmnisErrorCode, number>> = {
  [ERROR_CODES.validationFailed]: 400,
  [ERROR_CODES.configurationInvalid]: 500,
  [ERROR_CODES.notFound]: 404,
  [ERROR_CODES.conflict]: 409,
  [ERROR_CODES.authenticationFailed]: 401,
  [ERROR_CODES.authorizationFailed]: 403,
  [ERROR_CODES.policyViolation]: 403,
  [ERROR_CODES.providerFailure]: 502,
  [ERROR_CODES.executionFailed]: 500,
  [ERROR_CODES.timeout]: 504,
  [ERROR_CODES.infrastructureFailure]: 503,
  [ERROR_CODES.contractViolation]: 422,
  [ERROR_CODES.notImplemented]: 501,
  [ERROR_CODES.unknown]: 500,
};

/** Suggested HTTP status for a code, for use by transport adapters. */
export function httpStatusForCode(code: OmnisErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}
