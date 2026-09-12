/**
 * Result type used by every non-throwing parser in `@omnis/types`.
 *
 * WHY a Result type
 * -----------------
 * Parsing an identifier, a timestamp or a URI is an expected-failure operation,
 * not an exceptional one: untrusted input arrives from social platforms, webhooks
 * and event payloads constantly. Throwing for expected failures forces callers
 * into try/catch noise and makes it easy to swallow real bugs. A discriminated
 * union makes the failure branch part of the type signature, so the compiler
 * forces callers to handle it.
 *
 * Throwing variants (`parseIdentifier`, `parseIsoDateTime`, ...) are layered on
 * top for call sites where invalid input genuinely is a programming error.
 */

import { OmnisTypeError } from "./errors.js";

/** A successful parse carrying the validated, branded value. */
export interface ParseSuccess<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

/**
 * A failed parse carrying a stable, human-readable reason.
 *
 * `reason` must never contain secrets. It may contain the offending input when
 * the input is a public identifier or a malformed literal; parsers that handle
 * credentials must not use this type directly.
 */
export interface ParseFailure {
  readonly ok: false;
  readonly reason: string;
}

/** Discriminated union returned by all `tryParse*` functions. */
export type ParseResult<TValue> = ParseSuccess<TValue> | ParseFailure;

/** Builds a success result. */
export function parseSuccess<TValue>(value: TValue): ParseSuccess<TValue> {
  return { ok: true, value };
}

/** Builds a failure result. */
export function parseFailure(reason: string): ParseFailure {
  return { ok: false, reason };
}

/** Type guard narrowing a {@link ParseResult} to its success branch. */
export function isParseSuccess<TValue>(
  result: ParseResult<TValue>,
): result is ParseSuccess<TValue> {
  return result.ok;
}

/** Type guard narrowing a {@link ParseResult} to its failure branch. */
export function isParseFailure<TValue>(result: ParseResult<TValue>): result is ParseFailure {
  return !result.ok;
}

/**
 * Unwraps a result or throws an {@link OmnisTypeError} carrying the failure reason.
 *
 * Intended for call sites where the value has already been validated upstream (for
 * example immediately after a schema parse) and a failure indicates a programming
 * error rather than bad input.
 *
 * Throws a typed error rather than a bare `Error` so that callers can discriminate
 * this failure from an unrelated one. A plain `Error` cannot be caught selectively,
 * which in practice means either swallowing it or letting it escape as a 500 with no
 * machine-readable code.
 */
export function unwrapParseResult<TValue>(result: ParseResult<TValue>): TValue {
  if (result.ok) {
    return result.value;
  }
  throw new OmnisTypeError("parse_unwrap_failed", `Parse failed: ${result.reason}`);
}
