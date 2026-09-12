/**
 * `@omnis/errors` — the OMNIS typed error hierarchy.
 *
 * Depends only on `@omnis/types`. Nothing in this package knows about a
 * transport, a framework or a domain.
 */

export {
  ERROR_CODES,
  ERROR_CODE_VALUES,
  httpStatusForCode,
  isOmnisErrorCode,
  isRetryableCode,
} from "./error-codes.js";
export type { ErrorCodeKey, OmnisErrorCode } from "./error-codes.js";

export {
  isJsonObjectValue,
  isSensitiveKey,
  isSensitiveValue,
  REDACTED,
  redactAttributes,
  redactObject,
  redactSecrets,
  redactString,
} from "./redaction.js";

export { compactDetails, isOmnisError, OmnisError, toOmnisError } from "./omnis-error.js";
export type {
  ErrorMetadata,
  OmnisErrorOptions,
  SerializeErrorOptions,
  SerializedErrorCause,
  SerializedOmnisError,
} from "./omnis-error.js";

export {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ConfigurationError,
  ContractError,
  ExecutionError,
  InfrastructureError,
  NotImplementedError,
  NotFoundError,
  omnisErrorFromSerialized,
  PolicyViolationError,
  ProviderError,
  TimeoutError,
  ValidationError,
} from "./errors.js";
export type {
  AuthorizationErrorOptions,
  ConfigurationErrorOptions,
  ContractErrorOptions,
  ExecutionErrorOptions,
  NotImplementedErrorOptions,
  PolicyViolationErrorOptions,
  ProviderErrorOptions,
  TimeoutErrorOptions,
  ValidationIssue,
  ValidationErrorOptions,
} from "./errors.js";
