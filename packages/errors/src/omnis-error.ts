/**
 * `OmnisError` — the base of the OMNIS typed error hierarchy.
 *
 * WHY a shared base class
 * -----------------------
 * Every subsystem needs the same four things from a failure: what kind of failure
 * it was (`code`), what happened (`message`), why (`cause`), and enough context to
 * debug it (`metadata`). It also needs to know whether retrying is worthwhile.
 * Encoding that once means retry logic, alerting, approval gates and API error
 * mapping are written a single time instead of once per domain.
 *
 * DESIGN RULES
 * ------------
 * - `code` is stable and machine-readable; `message` is for humans and may change.
 *   Nothing may branch on a message.
 * - Metadata is redacted **at construction**, not at serialization. An error can
 *   be logged, rethrown, wrapped or inspected many times; redacting once at the
 *   source means there is no code path that can accidentally observe the raw
 *   secret. See redaction.ts for the documented limitation.
 * - `cause` is preserved through the standard ES2022 `Error` cause chain so the
 *   original provider or driver error survives wrapping.
 * - Serialization is explicit and lossy-by-default: stack traces are omitted
 *   unless the caller asks for them, because stacks routinely embed file paths
 *   and occasionally argument values.
 */

import type { JsonObject, JsonValue } from "@omnis/types";
import { nowIso } from "@omnis/types";
import { ERROR_CODES, isRetryableCode, type OmnisErrorCode } from "./error-codes.js";
import { redactAttributes, redactString } from "./redaction.js";

/**
 * Redacted, JSON-safe debugging context attached to an error.
 *
 * Typed as `JsonObject` rather than `Record<string, unknown>` because metadata is
 * routinely serialized into logs, events and API error bodies. `redactAttributes`
 * guarantees the shape at construction, so the type is a real invariant rather
 * than an aspiration.
 */
export type ErrorMetadata = Readonly<JsonObject>;

/** Options accepted by every {@link OmnisError} subclass. */
export interface OmnisErrorOptions {
  /** The underlying error, preserved as the standard `Error.cause`. */
  readonly cause?: unknown;
  /** Debugging context. Secret-shaped keys and values are redacted. */
  readonly metadata?: Record<string, unknown>;
  /** Overrides the code-derived retryability default. */
  readonly retryable?: boolean;
  /** Hint for callers backing off before a retry. */
  readonly retryAfterMs?: number;
}

/** A serialized cause, either a nested OMNIS error or a bare message. */
export type SerializedErrorCause =
  SerializedOmnisError | { readonly message: string; readonly name?: string };

/** The wire format of an OMNIS error. */
export interface SerializedOmnisError {
  readonly name: string;
  readonly code: OmnisErrorCode;
  readonly message: string;
  readonly metadata: JsonObject;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly occurredAt: string;
  readonly stack?: string;
  readonly cause?: SerializedErrorCause;
}

/** Controls what {@link OmnisError.serialize} includes. */
export interface SerializeErrorOptions {
  /** Include stack traces. Off by default; enable only for local diagnostics. */
  readonly includeStack?: boolean;
  /** Maximum cause-chain depth, guarding against pathological nesting. */
  readonly maxCauseDepth?: number;
}

const DEFAULT_MAX_CAUSE_DEPTH = 5;

/**
 * Base class for every error OMNIS raises.
 *
 * Subclasses must set `this.name` explicitly rather than relying on
 * `constructor.name`, which is not stable under minification.
 */
export class OmnisError extends Error {
  /** Stable machine-readable classification. */
  readonly code: OmnisErrorCode;

  /** Redacted debugging context. */
  readonly metadata: ErrorMetadata;

  /** Whether retrying the same operation unchanged may succeed. */
  readonly retryable: boolean;

  /** Optional backoff hint for retryable errors. */
  readonly retryAfterMs: number | undefined;

  /** When the error was constructed, as a UTC ISO 8601 timestamp. */
  readonly occurredAt: string;

  constructor(code: OmnisErrorCode, message: string, options: OmnisErrorOptions = {}) {
    // The message is redacted at construction for the same reason the metadata is:
    // the in-memory object must never hold a credential that a debugger, a log line
    // or a later serialization can read. `message` is the one field of an error that
    // cannot be dropped, and it is the field most often built by interpolating
    // whatever the failing call happened to be holding — an API key read back into a
    // "request failed for sk-..." string is the canonical leak.
    super(
      redactString(message),
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    this.name = "OmnisError";
    this.code = code;
    this.metadata = redactAttributes(options.metadata ?? {});
    this.retryable = options.retryable ?? isRetryableCode(code);
    this.retryAfterMs = options.retryAfterMs;
    this.occurredAt = nowIso();

    // Restores `instanceof` for subclasses when the output is down-levelled by a
    // consumer's bundler. Without it, `err instanceof ValidationError` silently
    // becomes false after transpilation to ES5.
    Object.setPrototypeOf(this, new.target.prototype);

    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, new.target);
    }
  }

  /**
   * Produces the wire representation.
   *
   * Metadata was already redacted at construction, so this method performs no
   * further secret handling — it only decides whether to include the stack.
   */
  serialize(options: SerializeErrorOptions = {}): SerializedOmnisError {
    const includeStack = options.includeStack ?? false;
    const maxCauseDepth = options.maxCauseDepth ?? DEFAULT_MAX_CAUSE_DEPTH;

    const serialized: SerializedOmnisError = {
      name: this.name,
      code: this.code,
      message: this.message,
      metadata: { ...this.metadata, ...this.serializeDetails() },
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      occurredAt: this.occurredAt,
      ...(includeStack && this.stack !== undefined ? { stack: this.stack } : {}),
      ...(maxCauseDepth > 0 && this.cause !== undefined
        ? { cause: serializeCause(this.cause, maxCauseDepth - 1) }
        : {}),
    };
    return serialized;
  }

  /**
   * Contributes class-specific fields to the serialized form.
   *
   * WHY: an error frequently crosses a process boundary (service → queue →
   * consumer, or API → client). The consumer needs the classification *and* the
   * detail that makes it actionable — which policy was violated, which provider
   * failed, what the deadline was. Rather than forcing every call site to
   * duplicate those values into `metadata` by hand, each subclass declares them
   * once here.
   *
   * The in-memory `metadata` is deliberately left untouched: it stays exactly the
   * caller-supplied, redacted context, so there is a single unambiguous place to
   * look when debugging locally.
   */
  protected serializeDetails(): JsonObject {
    return {};
  }

  /**
   * Hook used by `JSON.stringify`.
   *
   * It deliberately takes no parameters: `JSON.stringify` passes the property
   * *key* as the first argument, so a parameter defaulting to `false` would
   * receive a truthy string and silently start emitting stack traces into every
   * serialized log line.
   */
  toJSON(): SerializedOmnisError {
    return this.serialize();
  }

  /** Single-line form suitable for a log message or a test assertion. */
  override toString(): string {
    return `${this.name}(${this.code}): ${this.message}`;
  }
}

/** Serializes a cause of unknown provenance. */
function serializeCause(cause: unknown, remainingDepth: number): SerializedErrorCause {
  if (cause instanceof OmnisError) {
    return cause.serialize({ maxCauseDepth: remainingDepth });
  }
  if (cause instanceof Error) {
    return { name: cause.name, message: redactString(cause.message) };
  }
  if (typeof cause === "string") {
    return { message: redactString(cause) };
  }
  return { message: `Unserializable cause of type ${typeof cause}` };
}

/**
 * Drops `undefined` entries so a details object satisfies {@link JsonObject}.
 *
 * `undefined` has no JSON representation and would either be silently discarded
 * by `JSON.stringify` (changing the object's shape unpredictably) or turn into
 * `null` (asserting a value is known-absent rather than unknown). Subclasses use
 * this so they can list every field unconditionally.
 */
export function compactDetails(
  details: Readonly<Record<string, JsonValue | undefined>>,
): JsonObject {
  const compacted: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
}

/** Type guard for anything in the OMNIS error hierarchy. */
export function isOmnisError(value: unknown): value is OmnisError {
  return value instanceof OmnisError;
}

/**
 * Coerces an unknown thrown value into an {@link OmnisError}.
 *
 * `catch` blocks receive `unknown` (enforced by `useUnknownInCatchVariables`).
 * Anything can be thrown in JavaScript — strings, objects, `null` — and a
 * boundary that lets a non-error value escape produces an unclassifiable failure.
 * Wrapping it as `unknown` preserves the original as `cause` so no information is
 * lost while guaranteeing downstream code always sees an {@link OmnisError}.
 */
export function toOmnisError(value: unknown, context?: Record<string, unknown>): OmnisError {
  if (value instanceof OmnisError) {
    return value;
  }
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "An unexpected non-error value was thrown";

  return new OmnisError(ERROR_CODES.unknown, message, {
    cause: value,
    metadata: context,
    retryable: false,
  });
}
