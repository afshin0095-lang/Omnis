/**
 * Reading and coercing environment variables.
 *
 * Every value in `process.env` is `string | undefined`, and every one of them is
 * attacker-influenced in the sense that a deployment mistake — a stray space, an
 * unquoted `true`, a Kubernetes ConfigMap key typo — arrives as text that does not
 * mean what it looks like. Coercion therefore has to be explicit and strict.
 *
 * The rules below are deliberately unforgiving:
 *
 * - A boolean accepts only an explicit set of spellings. `""`, `"TRUE "` and
 *   `"maybe"` are rejected rather than coerced to `false`, because silently
 *   treating a malformed flag as "off" is how a feature gets disabled in
 *   production without anyone deciding to disable it.
 * - An integer must match `/^-?\d+$/`. `Number("12abc")` is `12` and
 *   `Number("")` is `0`; both would be accepted by a naive coercion and both are
 *   wrong.
 */

import { z } from "@omnis/validation";

/** Canonical environment variable names for OMNIS core configuration. */
export const ENV_KEYS = {
  environment: "OMNIS_ENV",
  serviceName: "OMNIS_SERVICE_NAME",
  logLevel: "OMNIS_LOG_LEVEL",
  logFormat: "OMNIS_LOG_FORMAT",
  telemetryEnabled: "OMNIS_TELEMETRY_ENABLED",
  strictConfiguration: "OMNIS_CONFIG_STRICT",
  defaultTenantId: "OMNIS_TENANT_ID",
  /** Fallback for the environment when `OMNIS_ENV` is unset. */
  nodeEnvironment: "NODE_ENV",
} as const;

/** The environment record a loader reads from. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** Accepted spellings for a boolean environment variable. */
const TRUE_VALUES = ["true", "1", "yes", "on"] as const;
const FALSE_VALUES = ["false", "0", "no", "off"] as const;

/**
 * A boolean parsed from an environment variable.
 *
 * Case-insensitive and trimmed, because `OMNIS_TELEMETRY_ENABLED=True` and
 * `...= true` are both plausible outcomes of hand-edited deployment files and
 * neither deserves to take a service down.
 */
export const booleanEnvSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine(
    (value) =>
      (TRUE_VALUES as readonly string[]).includes(value) ||
      (FALSE_VALUES as readonly string[]).includes(value),
    { error: "Expected one of: true, false, 1, 0, yes, no, on, off" },
  )
  .transform((value) => (TRUE_VALUES as readonly string[]).includes(value));

/** An integer parsed from an environment variable. */
export const integerEnvSchema = z
  .string()
  .trim()
  .regex(/^-?\d+$/, { error: "Expected an integer with no decimal or thousands separator" })
  .transform((value) => Number.parseInt(value, 10));

/** A non-negative integer parsed from an environment variable. */
export const nonNegativeIntegerEnvSchema = integerEnvSchema.refine((value) => value >= 0, {
  error: "Expected a non-negative integer",
});

/** A positive integer parsed from an environment variable. */
export const positiveIntegerEnvSchema = integerEnvSchema.refine((value) => value > 0, {
  error: "Expected an integer greater than zero",
});

/** Reads a single variable, treating an empty or whitespace-only value as unset. */
export function readEnvVariable(env: EnvironmentVariables, key: string): string | undefined {
  // Own, string-valued properties only. An inherited member such as `toString` would
  // otherwise be read as a configuration value and then fail on `.trim()` — or worse,
  // be reported as "set" by `isEnvVariableSet` and steer a default that should have
  // applied. `process.env` only ever has own string properties, but this is a trust
  // boundary and the record is injectable.
  if (!Object.hasOwn(env, key)) {
    return undefined;
  }
  const value = env[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** True when a variable is present and non-empty. */
export function isEnvVariableSet(env: EnvironmentVariables, key: string): boolean {
  return readEnvVariable(env, key) !== undefined;
}

/**
 * Names of the `OMNIS_`-prefixed variables actually present in an environment.
 *
 * Used by the `system.configuration.loaded` event, which reports key *names* only
 * — never values — so that a missing-variable incident can be diagnosed without
 * any risk of a secret reaching the event stream.
 */
export function listOmnisEnvKeys(env: EnvironmentVariables): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith("OMNIS_"))
    .sort();
}
