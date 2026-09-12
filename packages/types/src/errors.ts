/**
 * Minimal error types owned by `@omnis/types`.
 *
 * WHY these live here and not in `@omnis/errors`
 * ----------------------------------------------
 * `@omnis/errors` depends on `@omnis/types` (error metadata is keyed by
 * identifier kinds). If `@omnis/types` depended on `@omnis/errors` the two would
 * form a cycle, which the architecture tests in `tests/architecture` forbid.
 *
 * These types therefore cover exactly one concern — "a value could not be
 * coerced into a well-formed primitive" — and `@omnis/errors` exposes richer,
 * serializable errors (`ValidationError`, `ContractError`) for domain and
 * transport boundaries. Adapters at service boundaries should catch
 * {@link OmnisTypeError} and rethrow as `ValidationError` so callers never need
 * to know which layer produced the failure.
 *
 * INVARIANT: messages must never interpolate secrets. They may interpolate the
 * rejected value, because every parser in this package handles public
 * identifiers and structural literals only.
 */

/** Base class for all `@omnis/types` failures. */
export class OmnisTypeError extends Error {
  /** Stable machine-readable discriminator. */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OmnisTypeError";
    this.code = code;
    // Restores the prototype chain when the package is down-levelled to ES5 by a
    // consumer's bundler; harmless under the ES2023 target OMNIS emits.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Renders the error as a stable, loggable string. */
  override toString(): string {
    return `${this.name}(${this.code}): ${this.message}`;
  }
}

/** Thrown when a string cannot be parsed into the requested identifier kind. */
export class InvalidIdentifierError extends OmnisTypeError {
  /** The identifier kind that was requested, e.g. `"character"`. */
  readonly kind: string;

  /** The rejected value, truncated so oversized payloads cannot flood logs. */
  readonly received: string;

  constructor(kind: string, received: string, reason: string) {
    super(
      "invalid_identifier",
      `Invalid ${kind} identifier: ${reason} (received ${quote(truncate(received))})`,
    );
    this.name = "InvalidIdentifierError";
    this.kind = kind;
    this.received = truncate(received);
  }
}

/** Thrown when a value cannot be parsed into a branded primitive. */
export class InvalidValueError extends OmnisTypeError {
  /** The primitive that was requested, e.g. `"IsoDateTimeString"`. */
  readonly type: string;

  constructor(type: string, reason: string, received?: string) {
    super(
      "invalid_value",
      received === undefined
        ? `Invalid ${type}: ${reason}`
        : `Invalid ${type}: ${reason} (received ${quote(truncate(received))})`,
    );
    this.name = "InvalidValueError";
    this.type = type;
  }
}

const MAX_ECHO_LENGTH = 64;

/**
 * Caps how much of a rejected value is kept for echoing.
 *
 * A malformed field can be arbitrarily large (a whole request body mis-assigned to an
 * identifier slot). Truncating keeps log volume bounded and avoids accidentally
 * reproducing sensitive content that was passed by mistake.
 *
 * Returns the raw characters, not a quoted rendering: `received` is read
 * programmatically as well as printed, and a consumer comparing it against the value
 * it passed in must get that value back. Quoting is a message-formatting concern and
 * happens where the message is assembled.
 */
function truncate(value: string): string {
  if (value.length <= MAX_ECHO_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_ECHO_LENGTH)}...(${value.length} chars)`;
}

/**
 * Renders a value for inclusion in a message.
 *
 * Quoted, and via `JSON.stringify` rather than by appending quote characters, so
 * embedded quotes, backslashes and control characters are escaped instead of making
 * the message ambiguous to read or to parse.
 */
function quote(value: string): string {
  return JSON.stringify(value);
}
