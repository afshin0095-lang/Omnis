/**
 * Secret redaction for anything OMNIS serializes.
 *
 * WHY
 * ---
 * Errors, log records, event payloads and telemetry attributes all leave the
 * process: they go to stdout, to an observability vendor, to an event bus and
 * eventually into a bug report. Every one of those is a place a credential must
 * never appear. A leaked API key in a log aggregator is a full compromise of the
 * provider account, and log data is almost always retained far longer and shared
 * far more widely than the secret store it came from.
 *
 * Redaction is therefore applied by default at the serialization boundary rather
 * than being left to each call site's discipline.
 *
 * HOW
 * ---
 * Two independent detectors, because either one alone is insufficient:
 *
 * 1. Key-based. A key is tokenised (`apiKey`, `api_key`, `API-KEY` all yield
 *    `["api","key"]`) and matched against a denylist. Tokenising first is what
 *    stops naive substring matching from redacting `author`, `authority` or
 *    `keyboard` just because they contain `auth` or `key`.
 * 2. Value-based. A small set of high-confidence credential shapes (PEM blocks,
 *    `sk-`, `ghp_`, `AKIA`, `xox*`, `Bearer `) are matched regardless of the key
 *    they were stored under, which catches secrets placed in generically-named
 *    fields such as `value`, `data` or `input`.
 *
 * LIMITATION (documented, not hidden): this is defence in depth, not a
 * guarantee. A secret stored under a benign key with a novel shape will not be
 * caught. The primary control remains "never put a secret in a domain object";
 * see docs/01-architecture/SECURITY_BOUNDARIES.md.
 */

import type { JsonObject, JsonValue } from "@omnis/types";

/** Replacement written in place of a redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * Key tokens that mark a field as sensitive.
 *
 * Matched against the *whole* token, never as a substring.
 */
const SENSITIVE_KEY_TOKENS: ReadonlySet<string> = new Set([
  "api",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "certificate",
  "cookie",
  "credential",
  "credentials",
  "cvv",
  "key",
  "keys",
  "otp",
  "passcode",
  "password",
  "passwd",
  "pin",
  "private",
  "pwd",
  "secret",
  "secrets",
  "session",
  "signature",
  "ssn",
  "token",
  "tokens",
]);

/**
 * Keys that look sensitive by token but are not, in this codebase.
 *
 * Checked before the token scan. `ConfigurationError.keys` carries the *names* of the
 * environment variables that were missing, which is the only actionable content that
 * error has; redacting it left `keys: "[REDACTED]"` on the wire and made the failure
 * undiagnosable. A bare `keys` with no modifier names things far more often than it
 * holds credentials, while anything modified — `apiKeys`, `signingKeys`,
 * `privateKeys` — still trips the token scan. A credential-shaped *value* under a
 * benign key is still caught, because the value patterns run on every string.
 */
const BENIGN_EXACT_KEYS: ReadonlySet<string> = new Set(["keys"]);

/** Keys that are sensitive even though their individual tokens are innocuous. */
const SENSITIVE_EXACT_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "client_secret",
  "id_token",
  "refresh_token",
  "x-api-key",
]);

/**
 * High-confidence credential shapes, matched against string values.
 *
 * Deliberately conservative: each entry is a prefix or marker that essentially
 * never appears in legitimate content, so false positives are close to zero.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgho_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

/** Splits a key into comparable lowercase tokens. */
function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** True when a field name indicates the value is a secret. */
export function isSensitiveKey(key: string): boolean {
  const trimmed = key.trim();
  const normalised = trimmed.toLowerCase();
  if (BENIGN_EXACT_KEYS.has(normalised)) {
    return false;
  }
  if (SENSITIVE_EXACT_KEYS.has(normalised)) {
    return true;
  }
  // Tokenised from the *original* casing, not the lowercased form: the camelCase split
  // depends on the capital letters being present. Lowercasing first collapses
  // `privateKey` into the single token `privatekey`, which matches nothing and lets a
  // private key through into a log line.
  const tokens = tokenizeKey(trimmed);
  if (tokens.length === 0) {
    return false;
  }
  // A single-token key is only sensitive if it is itself on the denylist; this
  // keeps `monkey` or `turkey` out of scope while still catching `token`.
  return tokens.some((token) => SENSITIVE_KEY_TOKENS.has(token));
}

/** True when a string looks like a credential regardless of its key. */
export function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * The same credential shapes, compiled once with the global flag.
 *
 * Kept separate from {@link SENSITIVE_VALUE_PATTERNS} because a `g`-flagged RegExp is
 * stateful under `.test()`: `lastIndex` advances between calls, so a single shared
 * instance would make detection depend on how often it had previously been used.
 */
const REDACTION_PATTERN = new RegExp(
  SENSITIVE_VALUE_PATTERNS.map((pattern) => pattern.source).join("|"),
  "gi",
);

/**
 * Replaces every credential-shaped span in a string with {@link REDACTED}.
 *
 * Used for values whose key is not sensitive but whose content may be — most commonly
 * `message`, which is the one field of an error that cannot be dropped.
 *
 * Replaces the matched span rather than the whole string. Discarding the entire value
 * would turn "request failed for sk-... on tenant ten_1" into "[REDACTED]" and destroy
 * the diagnosis along with the secret; masking in place keeps both.
 */
export function redactString(value: string): string {
  return value.replace(REDACTION_PATTERN, REDACTED);
}

/**
 * Deeply redacts secrets from an arbitrary value **and** coerces the result into
 * a JSON-safe form.
 *
 * Both jobs happen in one pass because they are needed at exactly the same
 * boundary: anything that is about to be serialized into a log line, an event
 * payload or an error response. Doing them together means it is impossible to
 * redact without sanitizing, which would leave a `Date`, a `BigInt` or a circular
 * reference to break the serializer downstream.
 *
 * Guarantees of the return value:
 * - Contains only JSON-representable data (`undefined`, functions, symbols and
 *   `BigInt` become `null`; `NaN`/`Infinity` become `null`).
 * - `Date` becomes an ISO 8601 string; `Error` becomes `{ name, message }`.
 * - Circular references become the string `"[Circular]"`.
 * - Secret-shaped keys and values become {@link REDACTED}.
 * - Nesting is capped at `maxDepth`; anything deeper becomes {@link REDACTED}
 *   rather than being silently truncated mid-structure.
 *
 * The input is never mutated: the caller usually still needs the original (for
 * example to actually authenticate with it).
 */
export function redactSecrets(value: unknown, maxDepth = 8): JsonValue {
  return redactInner(value, maxDepth, new Set<object>());
}

function redactInner(value: unknown, depth: number, seen: Set<object>): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  switch (typeof value) {
    case "string":
      return redactString(value);
    case "boolean":
      return value;
    case "number":
      // NaN and Infinity have no JSON representation.
      return Number.isFinite(value) ? value : null;
    case "object":
      break;
    default:
      // function, symbol and bigint are not representable.
      return null;
  }

  if (depth <= 0) {
    return REDACTED;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactInner(entry, depth - 1, seen));
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactInner(redactString(value.message), depth - 1, seen),
      };
    }

    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? REDACTED : redactInner(entry, depth - 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/**
 * Redacts and sanitizes a value that is expected to be an object.
 *
 * Returns a `JsonObject` unconditionally. When the input turns out not to be an
 * object — a string thrown directly, a number, `null` — it is wrapped under a
 * `value` key rather than being coerced or discarded, so the caller never needs a
 * cast and never loses the information.
 */
export function redactObject(value: unknown): JsonObject {
  const redacted = redactSecrets(value);
  return isJsonObjectValue(redacted) ? redacted : { value: redacted };
}

/**
 * Type guard narrowing a {@link JsonValue} to {@link JsonObject}.
 *
 * A named guard rather than an inline condition because `Array.isArray` does not
 * narrow a `readonly JsonValue[]` — the built-in signature returns `arg is any[]`,
 * which a readonly array is not assignable to, so the inline form leaves the union
 * intact and the assignment fails.
 */
export function isJsonObjectValue(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Redacts and sanitizes a flat attribute map, preserving its key set.
 *
 * Used for error metadata, log context and telemetry attributes, where the shape
 * is a shallow record and callers want a `JsonObject` rather than a bare
 * `JsonValue`.
 *
 * Keys are always preserved (with sensitive values replaced) so that the *shape*
 * of a record stays inspectable in a log even when its contents had to be
 * withheld — knowing that a field existed is usually what makes a bug
 * diagnosable.
 */
export function redactAttributes(attributes: Readonly<Record<string, unknown>>): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactInner(value, 8, new Set<object>());
  }
  return result;
}
