/**
 * Opaque secret values.
 *
 * THE PROBLEM
 * -----------
 * A secret read from the environment is, in every other respect, an ordinary
 * string. It can be interpolated into a template literal, spread into a log
 * context, attached to an error's metadata, serialized into an event payload or
 * returned from an API handler — and none of those operations produce a warning.
 * Redaction catches the *shapes* of known credentials, but a secret with an
 * unfamiliar shape slips through, and the failure is silent and permanent: once a
 * key is in a log aggregator it must be treated as compromised and rotated.
 *
 * THE APPROACH
 * ------------
 * Make a secret a different *type* whose default behaviour is to withhold itself.
 * `String(secret)`, template interpolation, `JSON.stringify` and log formatting
 * all route through `toString()`/`toJSON()`, both of which return a fixed
 * redaction marker. Reading the real value requires an explicit `reveal()` call,
 * which is greppable, reviewable and confined to the credential adapters that
 * genuinely need it.
 *
 * This does not make a leak impossible — `reveal()` exists, and its result is an
 * ordinary string again. It makes a leak require a deliberate act instead of
 * happening by accident, which is the realistic goal.
 */

/** Marker emitted in place of a secret's value. */
export const SECRET_REDACTED = "[REDACTED:SECRET]";

/**
 * A credential that withholds its value by default.
 *
 * Deliberately an interface with methods rather than a class, so it survives
 * structured cloning boundaries badly but serializes safely everywhere that
 * matters — and so a consumer cannot `instanceof`-check its way into assuming a
 * particular implementation.
 */
export interface SecretValue {
  /** Discriminant, so a secret is recognisable in a heterogeneous value. */
  readonly isSecret: true;
  /**
   * Returns the plaintext credential.
   *
   * Call this only where the credential is actually consumed: a provider client
   * constructor, an HTTP `Authorization` header, a database connection string.
   * Never in a log statement, an error message, an event payload or a response
   * body.
   */
  reveal(): string;
  /** Always {@link SECRET_REDACTED}. */
  toString(): string;
  /** Always {@link SECRET_REDACTED}, so `JSON.stringify` cannot leak it. */
  toJSON(): string;
  /** Length of the underlying value, for "is this set?" checks that need more than a boolean. */
  readonly length: number;
}

/** Wraps a plaintext credential in an opaque {@link SecretValue}. */
export function createSecret(value: string): SecretValue {
  // Captured in a closure rather than stored on a property, so the plaintext is
  // not reachable by enumerating the object or by a careless structuredClone.
  return {
    isSecret: true,
    reveal: () => value,
    toString: () => SECRET_REDACTED,
    toJSON: () => SECRET_REDACTED,
    get length(): number {
      return value.length;
    },
  };
}

/** Type guard for {@link SecretValue}. */
export function isSecretValue(value: unknown): value is SecretValue {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { isSecret?: unknown }).isSecret === true &&
    typeof (value as { reveal?: unknown }).reveal === "function"
  );
}

/**
 * True when the value is a secret that has not been set.
 *
 * An empty credential is a distinct condition from a missing one: `OMNIS_API_KEY`
 * absent means the feature is unconfigured, while present-but-empty usually means
 * a broken deployment or a templating mistake. Distinguishing them produces a
 * much more useful error message.
 */
export function isEmptySecret(value: SecretValue | null | undefined): boolean {
  return value === null || value === undefined || value.length === 0;
}

/**
 * Redacts any secrets found in a shallow record.
 *
 * Complements the key- and pattern-based redaction in `@omnis/errors` by
 * handling the one case it cannot: a secret stored under an innocuous key with an
 * unfamiliar shape. Because a {@link SecretValue} is self-identifying, it is
 * redacted regardless of where it appears.
 */
export function redactSecretValues(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = isSecretValue(value) ? SECRET_REDACTED : value;
  }
  return result;
}
