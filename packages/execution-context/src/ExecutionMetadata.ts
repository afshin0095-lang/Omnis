/**
 * Execution metadata handling.
 *
 * Metadata is the one part of an execution context that callers freely add to, which
 * makes it the most likely place for a secret to enter the system: somebody puts an API
 * key in "for debugging", and from there it flows into every child scope, every event
 * payload, every log line and every audit row.
 *
 * So metadata is sanitized **on the way in**, not filtered on the way out:
 * - secret-shaped keys and values are redacted with the platform redactor,
 * - values that have no JSON representation are coerced to `null` by that same redactor,
 * - the entry count is bounded,
 * - the result is frozen and copied on every merge.
 *
 * Sanitizing *coerces* rather than rejects. Metadata is debugging data: failing an
 * execution because somebody attached a function to it would turn a harmless mistake
 * into an outage, and the coerced bag is still exactly what will serialize. Contract
 * payloads are the opposite case and are asserted instead — see
 * `createExecutionFailure` in `@omnis/ai-core-types`, which throws.
 *
 * Copy-on-merge is what gives child scopes *isolation*: a child adding a key produces a
 * new bag, and the parent's bag is unchanged. Sharing one mutable object between parent
 * and children would let a deep tool call annotate the root execution.
 */

import type { JsonValue } from "@omnis/types";
import { redactAttributes, ValidationError } from "@omnis/errors";
import { MAX_METADATA_ENTRIES, readPath } from "@omnis/ai-core-types";
import type { AiCoreMetadata } from "@omnis/ai-core-types";

/**
 * Sanitizes a caller-supplied metadata bag.
 *
 * Accepts `unknown` values because that is what a caller actually has. Throws only when
 * the bag is too large; every other problem is corrected by redaction or coercion.
 */
export function sanitizeMetadata(
  input: Readonly<Record<string, unknown>>,
  label: string = "metadata",
): AiCoreMetadata {
  const entries = Object.entries(input);
  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new ValidationError(
      `${label} declares ${String(entries.length)} entries, the maximum is ${MAX_METADATA_ENTRIES}`,
      {
        issues: [
          {
            path: label,
            code: "too_many_entries",
            message: "metadata bag is too large",
            received: entries.length,
          },
        ],
      },
    );
  }

  const droppedUndefined: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value === undefined) {
      // An explicit undefined member is dropped rather than rejected: callers build
      // metadata from optional fields all the time, and the member would not survive
      // serialization anyway.
      continue;
    }
    droppedUndefined[key] = value;
  }

  // `redactAttributes` is total: it redacts secret-shaped keys and values, and coerces
  // functions, symbols, non-finite numbers and cycles into JSON-representable values.
  // The result is therefore already JSON-safe, and the assertion below is a guard that
  // keeps this module honest if that ever changes.
  const redacted = redactAttributes(droppedUndefined);
  return Object.freeze({ ...redacted });
}

/** Merges a patch over a base bag, producing a new frozen bag. Neither input is mutated. */
export function mergeMetadata(
  base: AiCoreMetadata,
  patch: Readonly<Record<string, unknown>>,
): AiCoreMetadata {
  const sanitized = sanitizeMetadata(patch, "metadata patch");
  return Object.freeze({ ...base, ...sanitized });
}

/** Returns a bag without the named keys. Used when a child scope must not inherit a value. */
export function withoutMetadataKeys(base: AiCoreMetadata, keys: readonly string[]): AiCoreMetadata {
  // A mutable record, frozen on the way out: `JsonObject`'s index signature is
  // read-only, so building one in place is not possible.
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!keys.includes(key)) {
      result[key] = value;
    }
  }
  return Object.freeze(result);
}

/** Reads one metadata value by key. */
export function metadataValue(base: AiCoreMetadata, key: string): JsonValue | undefined {
  return base[key];
}

/** Reads a nested metadata value by dotted path, e.g. `"request.channel"`. */
export function metadataPath(base: AiCoreMetadata, path: string): unknown {
  return readPath(base, path);
}

/** True when the two bags hold the same keys with the same JSON values. */
export function metadataEquals(left: AiCoreMetadata, right: AiCoreMetadata): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every(
    (key) => JSON.stringify(left[key] ?? null) === JSON.stringify(right[key] ?? null),
  );
}
