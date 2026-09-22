/**
 * JSON-safety for AI Core records.
 *
 * Every AI Core record is eventually serialized: into an event payload, a telemetry
 * attribute, an audit row or an API response. `JSON.stringify` does not fail loudly
 * on the values that break a contract — it silently drops `undefined` object members,
 * turns functions into nothing, and throws only on cycles (after the expensive work
 * was already done). A model descriptor carrying a function would round-trip into a
 * *different* descriptor with no error anywhere.
 *
 * `assertJsonSafe` converts that silent corruption into a typed
 * {@link ValidationError} at the point the record enters the system, with the
 * offending path in the message.
 */

import { ValidationError } from "@omnis/errors";
import { MAX_JSON_SAFE_DEPTH } from "./constants.js";

/** The result of walking a value: either safe, or the path of the first problem. */
export type JsonSafety =
  | { readonly safe: true }
  | { readonly safe: false; readonly path: string; readonly reason: string };

const PRIMITIVE_OK = new Set(["string", "number", "boolean"]);

/**
 * Finds the first value that would not survive a JSON round-trip.
 *
 * Iterative rather than recursive: metadata comes from callers, and a caller-supplied
 * structure 10 000 levels deep must produce a finding, not a stack overflow.
 */
export function findJsonSafetyIssue(
  value: unknown,
  maxDepth: number = MAX_JSON_SAFE_DEPTH,
): JsonSafety {
  const stack: Array<{ readonly value: unknown; readonly path: string; readonly depth: number }> = [
    { value, path: "$", depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      // Unreachable: the loop only runs while the stack is non-empty.
      continue;
    }
    const { value: node, path, depth } = current;

    if (node === null || PRIMITIVE_OK.has(typeof node)) {
      // Numbers must additionally be finite: JSON has no NaN or Infinity, and
      // `JSON.stringify(NaN)` yields `null`, silently changing the value.
      if (typeof node === "number" && !Number.isFinite(node)) {
        return { safe: false, path, reason: "number is not finite" };
      }
      continue;
    }

    if (typeof node !== "object") {
      return { safe: false, path, reason: `unsupported type ${typeof node}` };
    }

    if (depth >= maxDepth) {
      return { safe: false, path, reason: `exceeds maximum depth of ${maxDepth}` };
    }

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        stack.push({ value: node[index], path: `${path}[${index}]`, depth: depth + 1 });
      }
      continue;
    }

    for (const [key, member] of Object.entries(node)) {
      if (member === undefined) {
        // Dropped by JSON.stringify: the record that comes back is not the record
        // that went in, which is exactly the corruption this module exists to stop.
        return {
          safe: false,
          path: `${path}.${key}`,
          reason: "undefined member is dropped by JSON serialization",
        };
      }
      stack.push({ value: member, path: `${path}.${key}`, depth: depth + 1 });
    }
  }

  return { safe: true };
}

/** True when the value survives a JSON round-trip unchanged. */
export function isJsonSafe(value: unknown, maxDepth: number = MAX_JSON_SAFE_DEPTH): boolean {
  return findJsonSafetyIssue(value, maxDepth).safe;
}

/**
 * Asserts JSON-safety, throwing a {@link ValidationError} naming the offending path.
 *
 * Called by every AI Core factory that accepts caller-supplied metadata or details,
 * so the invariant is established at construction instead of discovered at
 * serialization.
 */
export function assertJsonSafe(
  value: unknown,
  label: string,
  maxDepth: number = MAX_JSON_SAFE_DEPTH,
): void {
  const issue = findJsonSafetyIssue(value, maxDepth);
  if (issue.safe) {
    return;
  }
  throw new ValidationError(`${label} must be JSON-safe`, {
    issues: [
      {
        path: issue.path,
        code: "invalid_json",
        message: issue.reason,
        // The offending value is deliberately not echoed: metadata that fails a
        // JSON-safety check is exactly the kind of value that may hold a function
        // closure over a credential.
        received: null,
      },
    ],
    metadata: { label, path: issue.path, reason: issue.reason },
  });
}

/** Segments that must never be resolved, because they reach the prototype chain. */
const FORBIDDEN_PATH_SEGMENTS: readonly string[] = Object.freeze([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Reads a dotted path out of an unknown value, e.g. `"request.channel"` or `"items.0.id"`.
 *
 * Returns `undefined` for anything missing, and refuses to traverse `__proto__`,
 * `prototype` or `constructor`. That refusal matters because this reader is how policy
 * conditions address their fields: a caller-supplied condition string must not be able
 * to read — or, through a careless writer elsewhere, appear to authorize against —
 * inherited properties that no record ever set.
 *
 * Only own properties are read, arrays are indexed by numeric segments, and no
 * coercion happens: `"0"` on an object looks for the key `"0"`, not the first element.
 */
export function readPath(source: unknown, path: string): unknown {
  if (path.length === 0) {
    return source;
  }
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (FORBIDDEN_PATH_SEGMENTS.includes(segment)) {
      return undefined;
    }
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** True when the dotted path resolves to a value other than `undefined`. */
export function hasPath(source: unknown, path: string): boolean {
  return readPath(source, path) !== undefined;
}
