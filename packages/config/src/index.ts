/**
 * `@omnis/config` — typed, schema-validated configuration.
 *
 * Reads the environment, validates it against a schema, applies defaults where a
 * default is safe, and fails fast where one is not. No secret is ever committed,
 * logged or placed in an event; credentials are handled through
 * {@link SecretValue}, which withholds its contents by default.
 *
 * Dependencies: `@omnis/types`, `@omnis/errors`, `@omnis/validation`.
 */

export {
  booleanEnvSchema,
  ENV_KEYS,
  integerEnvSchema,
  isEnvVariableSet,
  listOmnisEnvKeys,
  nonNegativeIntegerEnvSchema,
  positiveIntegerEnvSchema,
  readEnvVariable,
} from "./env.js";
export type { EnvironmentVariables } from "./env.js";

export {
  configurationErrorFromFailure,
  coreConfigSchemaFor,
  defaultLogLevel,
  loadConfig,
  loadOmnisConfig,
  resolveEnvironment,
} from "./core-config.js";
export type { OmnisCoreConfig } from "./core-config.js";

export {
  createSecret,
  isEmptySecret,
  isSecretValue,
  redactSecretValues,
  SECRET_REDACTED,
} from "./secret.js";
export type { SecretValue } from "./secret.js";
