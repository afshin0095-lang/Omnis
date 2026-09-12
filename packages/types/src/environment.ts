/**
 * The deployment environments OMNIS recognises.
 *
 * WHY this is a closed set
 * ------------------------
 * Behaviour that differs by environment — fail-fast configuration, log verbosity,
 * whether a provider call may spend money, whether publishing is real or dry-run —
 * must branch on a value that cannot be misspelled. An open `string` environment
 * is how a system ends up running production behaviour in a "prod" environment
 * that no code path recognised, or silently treating "Production" as
 * non-production because the comparison was case-sensitive.
 *
 * `production` is the only value that enables fail-fast configuration and the
 * only one in which side-effecting integrations are expected to be live. Every
 * other value is a non-production environment by definition.
 */

/** Every environment OMNIS may run in. */
export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;

/** One member of {@link ENVIRONMENTS}. */
export type EnvironmentName = (typeof ENVIRONMENTS)[number];

/** Type guard for an environment name. */
export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === "string" && (ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Normalises loosely-typed environment names from the shell.
 *
 * Environment variables arrive as arbitrary text and are conventionally
 * inconsistent (`PROD`, `Prod`, `production`, `prod`). Normalising once, here,
 * means no other module has to defend against casing or abbreviation.
 *
 * Returns `null` for anything unrecognised rather than defaulting: silently
 * falling back to `development` would disable production fail-fast checks, and
 * silently falling back to `production` would enable real side effects in a test
 * run. Both are worse than refusing to start.
 */
export function normaliseEnvironmentName(value: unknown): EnvironmentName | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.trim().toLowerCase()) {
    case "dev":
    case "development":
    case "local":
      return "development";
    case "test":
    case "testing":
    case "ci":
      return "test";
    case "staging":
    case "stage":
    case "preprod":
    case "uat":
      return "staging";
    case "prod":
    case "production":
    case "live":
      return "production";
    default:
      return null;
  }
}

/** True only for `production`. */
export function isProduction(environment: EnvironmentName): boolean {
  return environment === "production";
}

/** True for any environment that is not `production`. */
export function isNonProduction(environment: EnvironmentName): boolean {
  return environment !== "production";
}
