/**
 * Normalisation of vendor validation failures into {@link ValidationIssue}.
 *
 * The rest of OMNIS never sees a vendor error type. That is not cosmetics: retry
 * policies, HTTP status mapping, log redaction and the Studio error surface all
 * branch on `ValidationIssue`, and coupling them to a vendor's error shape would
 * mean a validation-library upgrade silently changes user-visible behaviour.
 *
 * Extraction is defensive on purpose. `OmnisSchema.safeParse` types the failure
 * as `unknown`, so this code must tolerate an error object that has no `issues`
 * array at all (a hand-rolled schema, a future vendor change, or a genuinely
 * unexpected throw) and still produce a usable message.
 */

import { redactSecrets, type ValidationIssue } from "@omnis/errors";

/** The shape this module looks for on an unknown error value. */
interface IssueBearing {
  readonly issues?: unknown;
}

/** A vendor issue in the loosest shape we are willing to interpret. */
interface RawIssue {
  readonly path?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly received?: unknown;
}

/**
 * Converts an unknown validation failure into normalised issues.
 *
 * Returns an empty array when nothing recognisable is present; callers pair it
 * with {@link summariseIssues}, which renders that case as `"unknown reason"`
 * rather than producing an empty message.
 */
export function toValidationIssues(error: unknown): ValidationIssue[] {
  if (error === null || typeof error !== "object") {
    return [];
  }
  const issues = (error as IssueBearing).issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  const normalised: ValidationIssue[] = [];
  for (const entry of issues) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    normalised.push(normaliseIssue(entry as RawIssue));
  }
  return normalised;
}

function normaliseIssue(issue: RawIssue): ValidationIssue {
  return {
    path: joinPath(issue.path),
    code: typeof issue.code === "string" ? issue.code : "invalid",
    message: typeof issue.message === "string" ? issue.message : "Validation failed",
    // The rejected value is attacker-controlled by definition (it is the input
    // that failed), so it is redacted and coerced to a JSON-safe form before it
    // can reach a log line or an API error body.
    received: issue.received === undefined ? null : redactSecrets(issue.received),
  };
}

/**
 * Joins a vendor path into a single dotted string.
 *
 * Array indices are rendered as plain segments (`items.0.id`), which is the
 * convention JSON Pointer-adjacent tooling and every OMNIS log consumer expects.
 * An empty path means the failure is at the root of the payload.
 */
function joinPath(path: unknown): string {
  if (!Array.isArray(path)) {
    return "";
  }
  return path
    .map((segment) => {
      if (typeof segment === "string") {
        return segment;
      }
      if (typeof segment === "number" || typeof segment === "bigint") {
        return String(segment);
      }
      // Vendors can emit objects (e.g. `{ key: ... }`) for map-like containers.
      return segment === null || segment === undefined ? "" : String(segment);
    })
    .filter((segment) => segment.length > 0)
    .join(".");
}

/**
 * Renders a short, bounded human-readable summary of a set of issues.
 *
 * Bounded because a deeply malformed payload can produce hundreds of issues, and
 * an unbounded message would flood log lines and error responses. The complete
 * list always remains available on `ValidationError.issues`.
 */
export function summariseIssues(issues: readonly ValidationIssue[], limit = 5): string {
  if (issues.length === 0) {
    return "unknown reason";
  }
  const shown = issues
    .slice(0, limit)
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path}: ${issue.message}`));
  const remaining = issues.length - shown.length;
  return remaining > 0 ? `${shown.join("; ")} (+${remaining} more)` : shown.join("; ");
}
