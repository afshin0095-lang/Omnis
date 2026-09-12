/**
 * OMNIS core configuration.
 *
 * This is the configuration every OMNIS process needs regardless of which domain
 * it implements: which environment it is in, what it is called, how loudly it
 * logs and whether it reports telemetry. Domain-specific configuration belongs to
 * the owning service and is layered on top of this by composing schemas.
 *
 * THE ENVIRONMENT-SENSITIVE SCHEMA
 * --------------------------------
 * {@link coreConfigSchemaFor} is a *function of the environment*, and that is the
 * mechanism behind "defaults where safe, fail-fast for required production
 * configuration":
 *
 * - In `development` and `test`, missing values fall back to defaults that make
 *   local work possible without a configuration file. A developer cloning the
 *   repository should be able to run something immediately.
 * - In `staging` and `production`, the values that determine attribution and
 *   observability have **no default** and must be supplied. A production service
 *   that does not know its own name produces unattributable logs and events, and
 *   "unattributable" in a multi-tenant system means "cannot be safely acted on".
 *
 * Resolving the environment is therefore a separate, prior step
 * ({@link resolveEnvironment}) that is strict in *every* environment: a
 * misspelled `OMNIS_ENV` must fail loudly rather than silently becoming
 * `development`, which would turn off production fail-fast at exactly the moment
 * it was needed.
 */

import { ConfigurationError } from "@omnis/errors";
import type { EnvironmentName, LogFormat, LogLevel, TenantId, TrimmedString } from "@omnis/types";
import { isProduction, normaliseEnvironmentName, parseTrimmedString } from "@omnis/types";
import {
  environmentSchema,
  identifierSchemas,
  logFormatSchema,
  logLevelSchema,
  serviceNameSchema,
  summariseIssues,
  toValidationIssues,
  z,
  type OmnisSchema,
} from "@omnis/validation";
import { booleanEnvSchema, ENV_KEYS, type EnvironmentVariables, readEnvVariable } from "./env.js";

/** The configuration every OMNIS process requires. */
export type OmnisCoreConfig = {
  readonly environment: EnvironmentName;
  /**
   * Logical name of this process, e.g. `content-factory` or
   * `audience-intelligence.ingestion`.
   *
   * Appears as `source` on every event this process emits and as `service` on
   * every log line. It is how an operator finds the owner of a failure.
   */
  readonly serviceName: TrimmedString;
  readonly logLevel: LogLevel;
  readonly logFormat: LogFormat;
  readonly telemetryEnabled: boolean;
  /**
   * Whether configuration problems are fatal.
   *
   * Defaults to `true` in production. It exists as an explicit switch so an
   * operator can see that the behaviour was chosen, and so a test can exercise
   * the strict path on a non-production environment.
   */
  readonly strictConfiguration: boolean;
  /**
   * Development-only default tenant.
   *
   * **Must be `null` in production.** A tenant taken from configuration rather
   * than from the request would let one tenant's workload be attributed to
   * another, which in a multi-tenant system is a data-isolation failure rather
   * than an inconvenience. {@link loadOmnisConfig} enforces this.
   */
  readonly defaultTenantId: TenantId | null;
};

/** Default tenant name used outside production when none is supplied. */
const LOCAL_SERVICE_NAME = parseTrimmedString("omnis.local");

/**
 * Builds the core configuration schema for an environment.
 *
 * Parameterised by environment so that the presence or absence of a default *is*
 * the environment policy, expressed in one place rather than scattered across
 * call sites as `if (env === "production")` checks.
 */
export function coreConfigSchemaFor(environment: EnvironmentName) {
  const managed = environment === "production" || environment === "staging";

  return z.object({
    [ENV_KEYS.environment]: environmentSchema.default(environment),
    // Attribution is mandatory in managed environments and defaulted locally.
    [ENV_KEYS.serviceName]: managed
      ? serviceNameSchema
      : serviceNameSchema.default(LOCAL_SERVICE_NAME),
    [ENV_KEYS.logLevel]: logLevelSchema.default(defaultLogLevel(environment)),
    [ENV_KEYS.logFormat]: logFormatSchema.default(managed ? "json" : "pretty"),
    [ENV_KEYS.telemetryEnabled]: booleanEnvSchema.default(environment === "production"),
    [ENV_KEYS.strictConfiguration]: booleanEnvSchema.default(isProduction(environment)),
    [ENV_KEYS.defaultTenantId]: identifierSchemas.tenant.nullable().default(null),
  });
}

/** The log level used when none is configured. */
export function defaultLogLevel(environment: EnvironmentName): LogLevel {
  switch (environment) {
    case "development":
      return "debug";
    case "test":
      // Tests should be quiet unless something is wrong; a chatty test suite
      // hides the one line that explains a failure.
      return "warn";
    case "staging":
    case "production":
      return "info";
  }
}

/**
 * Resolves the environment this process is running in.
 *
 * Reads `OMNIS_ENV`, falling back to `NODE_ENV`. Accepts the conventional
 * abbreviations (`prod`, `dev`, `ci`, ...) because those are what deployment
 * tooling actually sets.
 *
 * @throws {ConfigurationError} when a value is present but unrecognised. This is
 *   strict in every environment, including development: silently interpreting
 *   `OMNIS_ENV=productio` as `development` would disable production fail-fast
 *   checks on a deployment that believed it had them.
 */
export function resolveEnvironment(env: EnvironmentVariables): EnvironmentName {
  const raw =
    readEnvVariable(env, ENV_KEYS.environment) ?? readEnvVariable(env, ENV_KEYS.nodeEnvironment);

  if (raw === undefined) {
    // Nothing declared at all is treated as local development. This is the one
    // permissive default in the resolution path, and it is safe precisely
    // because it only applies when no value was supplied: a real deployment
    // always sets one of the two variables.
    return "development";
  }

  const resolved = normaliseEnvironmentName(raw);
  if (resolved === null) {
    throw new ConfigurationError(
      `Unrecognised environment "${raw}". Expected one of: development, test, staging, production ` +
        `(or a conventional abbreviation such as dev, ci, prod).`,
      { keys: [ENV_KEYS.environment, ENV_KEYS.nodeEnvironment], retryable: false },
    );
  }
  return resolved;
}

/**
 * Loads and validates OMNIS core configuration from an environment record.
 *
 * @param env Defaults to `process.env`. Injectable so tests are deterministic and
 *   never depend on, or mutate, the real process environment.
 * @throws {ConfigurationError} when a value is malformed, when a value required in
 *   this environment is missing, or when a production invariant is violated.
 */
export function loadOmnisConfig(env: EnvironmentVariables = process.env): OmnisCoreConfig {
  const environment = resolveEnvironment(env);
  const schema = coreConfigSchemaFor(environment);

  const result = schema.safeParse(env);
  if (!result.success) {
    throw configurationErrorFromFailure("OmnisCoreConfig", result.error);
  }

  // No casts: the schema is keyed by the literal `ENV_KEYS` members, so the parse
  // output is already precisely typed and this mapping is checked by the compiler.
  const parsed = result.data;
  const config: OmnisCoreConfig = {
    environment,
    serviceName: parsed[ENV_KEYS.serviceName],
    logLevel: parsed[ENV_KEYS.logLevel],
    logFormat: parsed[ENV_KEYS.logFormat],
    telemetryEnabled: parsed[ENV_KEYS.telemetryEnabled],
    strictConfiguration: parsed[ENV_KEYS.strictConfiguration],
    defaultTenantId: parsed[ENV_KEYS.defaultTenantId],
  };

  // Production invariant: tenancy must come from the request, never from config.
  if (isProduction(environment) && config.defaultTenantId !== null) {
    throw new ConfigurationError(
      `${ENV_KEYS.defaultTenantId} must not be set in production. Tenant context is derived ` +
        `from the authenticated request; a configured default tenant would attribute one ` +
        `tenant's workload to another.`,
      { keys: [ENV_KEYS.defaultTenantId], retryable: false },
    );
  }

  return config;
}

/**
 * Loads configuration through an arbitrary schema.
 *
 * The generic entry point for domain-specific configuration: a service composes
 * its own schema and calls this, so every configuration failure anywhere in OMNIS
 * surfaces as the same typed error with the same key attribution.
 */
export function loadConfig<TConfig>(
  schema: OmnisSchema<TConfig>,
  env: EnvironmentVariables,
  contractId = "OmnisConfig",
): TConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw configurationErrorFromFailure(contractId, result.error);
  }
  return result.data;
}

/**
 * Converts a schema failure into a {@link ConfigurationError}.
 *
 * The offending environment variable *names* are lifted into `keys` so an
 * operator sees `OMNIS_LOG_LEVEL` rather than a path into an internal object, and
 * so the failure can be reported without ever echoing a value — which matters
 * because the malformed value may itself have been a secret.
 */
export function configurationErrorFromFailure(
  contractId: string,
  error: unknown,
): ConfigurationError {
  const issues = toValidationIssues(error);
  return new ConfigurationError(`${contractId} is invalid: ${summariseIssues(issues, 8)}`, {
    keys: extractTopLevelKeys(issues),
    retryable: false,
  });
}

/**
 * Distinct top-level environment variable names implicated in a failure.
 *
 * Nested paths (`OMNIS_LIMITS.max`) collapse to their first segment, because that
 * is the variable an operator actually has to edit.
 */
function extractTopLevelKeys(issues: readonly { path: string }[]): string[] {
  const keys: string[] = [];
  for (const issue of issues) {
    const key = issue.path.split(".")[0];
    if (key !== undefined && key.length > 0 && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}
