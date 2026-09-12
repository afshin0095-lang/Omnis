/**
 * The concrete OMNIS error hierarchy.
 *
 * One class per *failure classification*, not one per call site. The
 * classification is what retry policies, approval gates, HTTP adapters and
 * alerting rules branch on, so it must be small, stable and exhaustive.
 *
 * | Class                 | Code                   | Retryable by default |
 * | --------------------- | ---------------------- | -------------------- |
 * | ValidationError       | validation_failed      | no                   |
 * | ConfigurationError    | configuration_invalid  | no                   |
 * | NotFoundError         | not_found              | no                   |
 * | ConflictError         | conflict               | no                   |
 * | AuthenticationError   | authentication_failed  | no                   |
 * | AuthorizationError    | authorization_failed   | no                   |
 * | PolicyViolationError  | policy_violation       | no                   |
 * | ProviderError         | provider_failure       | yes                  |
 * | ExecutionError        | execution_failed       | yes                  |
 * | TimeoutError          | timeout                | yes                  |
 * | InfrastructureError   | infrastructure_failure | yes                  |
 * | ContractError         | contract_violation     | no                   |
 * | NotImplementedError   | not_implemented        | no                   |
 *
 * "Retryable" always means "retrying the identical operation may succeed". A
 * `ProviderError` caused by a revoked API key is not retryable and must be
 * constructed with `{ retryable: false }`; callers must read `error.retryable`
 * rather than inferring it from the class.
 *
 * Each subclass overrides `serializeDetails()` so its typed fields survive a
 * process boundary, and {@link omnisErrorFromSerialized} reads them back.
 */

import type { JsonObject, JsonValue } from "@omnis/types";
import { ERROR_CODES, type OmnisErrorCode } from "./error-codes.js";
import {
  compactDetails,
  OmnisError,
  type OmnisErrorOptions,
  type SerializedOmnisError,
} from "./omnis-error.js";

/**
 * A single field-level validation failure.
 *
 * Declared as a type alias rather than an interface on purpose: only object
 * literal *types* are assignable to the index-signature shape that `JsonValue`
 * uses, so an interface here would make issues impossible to embed in error
 * metadata without a cast. `received` is nullable rather than optional for the
 * same reason — an optional property widens to `JsonValue | undefined`, which is
 * not JSON-representable.
 */
export type ValidationIssue = {
  /** Dotted path to the offending field; empty for a root-level failure. */
  readonly path: string;
  /** Stable, provider-independent issue code, e.g. `"invalid_type"`. */
  readonly code: string;
  /** Human-readable explanation. Must not contain secrets. */
  readonly message: string;
  /**
   * The rejected value, redacted and coerced to a JSON-safe form, or `null` when
   * echoing it back would be unsafe or unhelpful.
   */
  readonly received: JsonValue | null;
};

/** Options that additionally carry field-level validation issues. */
export type ValidationErrorOptions = OmnisErrorOptions & {
  readonly issues?: readonly ValidationIssue[];
};

/** A schema or domain invariant was violated by the supplied input. */
export class ValidationError extends OmnisError {
  /**
   * Per-field failures, when the error originated from a schema parse.
   *
   * Empty for invariant violations raised by hand, which carry their explanation
   * in `message` alone.
   */
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, options: ValidationErrorOptions = {}) {
    super(ERROR_CODES.validationFailed, message, {
      ...options,
      retryable: options.retryable ?? false,
    });
    this.name = "ValidationError";
    this.issues = options.issues ?? [];
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ issues: this.issues.length > 0 ? this.issues : undefined });
  }
}

/** Options that additionally name the offending configuration keys. */
export type ConfigurationErrorOptions = OmnisErrorOptions & {
  readonly keys?: readonly string[];
};

/** Environment or file configuration was missing, malformed or contradictory. */
export class ConfigurationError extends OmnisError {
  /** Names of the configuration keys involved, e.g. `OMNIS_LOG_LEVEL`. */
  readonly keys: readonly string[];

  constructor(message: string, options: ConfigurationErrorOptions = {}) {
    super(ERROR_CODES.configurationInvalid, message, {
      ...options,
      retryable: options.retryable ?? false,
    });
    this.name = "ConfigurationError";
    this.keys = options.keys ?? [];
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ keys: this.keys.length > 0 ? this.keys : undefined });
  }
}

/** A referenced entity does not exist. */
export class NotFoundError extends OmnisError {
  /** The kind of thing that was missing, e.g. `"character"`. */
  readonly resourceType: string;
  /** Its identifier, when known. */
  readonly resourceId: string | undefined;

  constructor(resourceType: string, resourceId?: string, options: OmnisErrorOptions = {}) {
    super(
      ERROR_CODES.notFound,
      resourceId === undefined
        ? `${resourceType} was not found`
        : `${resourceType} "${resourceId}" was not found`,
      { ...options, retryable: options.retryable ?? false },
    );
    this.name = "NotFoundError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ resourceType: this.resourceType, resourceId: this.resourceId });
  }
}

/**
 * The operation conflicts with the current state.
 *
 * Covers duplicates, stale expected-version writes and illegal state
 * transitions. Callers resolve a conflict by re-reading state, not by retrying
 * blindly, so it is not retryable by default.
 */
export class ConflictError extends OmnisError {
  /** The state or constraint that was violated. */
  readonly conflict: string;

  constructor(conflict: string, message: string, options: OmnisErrorOptions = {}) {
    super(ERROR_CODES.conflict, message, { ...options, retryable: options.retryable ?? false });
    this.name = "ConflictError";
    this.conflict = conflict;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ conflict: this.conflict });
  }
}

/** The caller could not be authenticated. */
export class AuthenticationError extends OmnisError {
  constructor(message: string, options: OmnisErrorOptions = {}) {
    super(ERROR_CODES.authenticationFailed, message, {
      ...options,
      retryable: options.retryable ?? false,
    });
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Options that additionally name the permission that was required. */
export type AuthorizationErrorOptions = OmnisErrorOptions & {
  readonly permission?: string;
};

/** The caller is authenticated but not permitted to perform the operation. */
export class AuthorizationError extends OmnisError {
  /** The permission that was required, e.g. `"content:publish"`. */
  readonly permission: string | undefined;

  constructor(message: string, options: AuthorizationErrorOptions = {}) {
    super(ERROR_CODES.authorizationFailed, message, {
      ...options,
      retryable: options.retryable ?? false,
    });
    this.name = "AuthorizationError";
    this.permission = options.permission;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ permission: this.permission });
  }
}

/** Options for a policy-gate rejection. */
export type PolicyViolationErrorOptions = OmnisErrorOptions & {
  readonly rule?: string;
  readonly requiresApproval?: boolean;
};

/**
 * A policy or approval gate rejected the operation.
 *
 * Distinct from {@link AuthorizationError}: authorization asks "may this actor
 * ever do this?", policy asks "may this action happen now, under these
 * conditions, without a human approving it?". Publishing outside an approved
 * window or exceeding a spend budget is a policy violation, not an authorization
 * failure, and the remediation paths are different.
 */
export class PolicyViolationError extends OmnisError {
  /** Identifier of the policy that was evaluated. */
  readonly policyId: string;
  /** The specific rule within the policy that failed. */
  readonly rule: string | undefined;
  /** Set when the action may proceed after explicit human approval. */
  readonly requiresApproval: boolean;

  constructor(policyId: string, message: string, options: PolicyViolationErrorOptions = {}) {
    super(ERROR_CODES.policyViolation, message, {
      ...options,
      retryable: options.retryable ?? false,
    });
    this.name = "PolicyViolationError";
    this.policyId = policyId;
    this.rule = options.rule;
    this.requiresApproval = options.requiresApproval ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({
      policyId: this.policyId,
      rule: this.rule,
      requiresApproval: this.requiresApproval,
    });
  }
}

/** Options describing which external provider failed. */
export type ProviderErrorOptions = OmnisErrorOptions & {
  readonly providerRef?: string;
  readonly providerStatus?: string;
};

/** An external provider failed, rate-limited or returned unusable output. */
export class ProviderError extends OmnisError {
  /**
   * Logical provider category, e.g. `"model"`, `"voice"`, `"video"`,
   * `"embedding"`.
   *
   * Never a vendor SDK name: naming the vendor here would let provider identity
   * leak into domain logic, which DEPENDENCY_RULES.md forbids.
   */
  readonly providerKind: string;
  /** The provider's own reference for this backend, e.g. a model slug. */
  readonly providerRef: string | undefined;
  /** The provider's status or error code, when it supplied one. */
  readonly providerStatus: string | undefined;

  constructor(providerKind: string, message: string, options: ProviderErrorOptions = {}) {
    super(ERROR_CODES.providerFailure, message, options);
    this.name = "ProviderError";
    this.providerKind = providerKind;
    this.providerRef = options.providerRef;
    this.providerStatus = options.providerStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({
      providerKind: this.providerKind,
      providerRef: this.providerRef,
      providerStatus: this.providerStatus,
    });
  }
}

/** Options identifying the execution that failed. */
export type ExecutionErrorOptions = OmnisErrorOptions & {
  readonly executionId?: string;
};

/** An agent, tool or pipeline execution failed. */
export class ExecutionError extends OmnisError {
  /** The execution that failed, for correlation with traces and events. */
  readonly executionId: string | undefined;

  constructor(message: string, options: ExecutionErrorOptions = {}) {
    super(ERROR_CODES.executionFailed, message, options);
    this.name = "ExecutionError";
    this.executionId = options.executionId;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ executionId: this.executionId });
  }
}

/** Options describing the deadline that was exceeded. */
export type TimeoutErrorOptions = OmnisErrorOptions & {
  readonly timeoutMs?: number;
  readonly operation?: string;
};

/** An operation exceeded its deadline. */
export class TimeoutError extends OmnisError {
  /** The deadline that was exceeded, in milliseconds. */
  readonly timeoutMs: number | undefined;
  /** What was being awaited, for log readability. */
  readonly operation: string | undefined;

  constructor(message: string, options: TimeoutErrorOptions = {}) {
    super(ERROR_CODES.timeout, message, options);
    this.name = "TimeoutError";
    this.timeoutMs = options.timeoutMs;
    this.operation = options.operation;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ timeoutMs: this.timeoutMs, operation: this.operation });
  }
}

/** A database, queue, network, storage or other infrastructure dependency failed. */
export class InfrastructureError extends OmnisError {
  /** The failing subsystem, e.g. `"event-store"`, `"object-storage"`. */
  readonly component: string;

  constructor(component: string, message: string, options: OmnisErrorOptions = {}) {
    super(ERROR_CODES.infrastructureFailure, message, options);
    this.name = "InfrastructureError";
    this.component = component;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ component: this.component });
  }
}

/** Options describing the contract that was violated. */
export type ContractErrorOptions = OmnisErrorOptions & {
  readonly contractVersion?: string;
  readonly receivedVersion?: string;
};

/**
 * A versioned contract was violated by a producer or consumer.
 *
 * Raised when an inbound event, command or API payload does not match the
 * contract version it claims to use. Kept separate from {@link ValidationError}
 * because the remediation differs: a validation error means the caller sent bad
 * data, a contract error means two deployments disagree and one of them must be
 * fixed or rolled back.
 */
export class ContractError extends OmnisError {
  /** Identifier of the contract, e.g. an event type. */
  readonly contractId: string;
  /** The contract version that was expected. */
  readonly contractVersion: string | undefined;
  /** The version actually presented, when known. */
  readonly receivedVersion: string | undefined;

  constructor(contractId: string, message: string, options: ContractErrorOptions = {}) {
    super(ERROR_CODES.contractViolation, message, {
      ...options,
      retryable: options.retryable ?? false,
    });
    this.name = "ContractError";
    this.contractId = contractId;
    this.contractVersion = options.contractVersion;
    this.receivedVersion = options.receivedVersion;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({
      contractId: this.contractId,
      contractVersion: this.contractVersion,
      receivedVersion: this.receivedVersion,
    });
  }
}

/** Options describing a deferred capability. */
export type NotImplementedErrorOptions = OmnisErrorOptions & {
  readonly trackedIn?: string;
};

/**
 * A declared capability is intentionally not implemented yet.
 *
 * This exists so deferred work has an explicit, observable runtime signal
 * instead of a bare untyped `throw` buried in a production path. A
 * capability that is not built yet must still be reachable through a typed
 * interface, must fail with a classifiable error, and must be listed in the
 * documentation as deferred.
 */
export class NotImplementedError extends OmnisError {
  /** The capability that was invoked, e.g. `"video.render"`. */
  readonly capability: string;
  /** Where the implementation is tracked or specified. */
  readonly trackedIn: string | undefined;

  constructor(capability: string, options: NotImplementedErrorOptions = {}) {
    super(
      ERROR_CODES.notImplemented,
      `Capability "${capability}" is declared but not implemented yet.`,
      { ...options, retryable: options.retryable ?? false },
    );
    this.name = "NotImplementedError";
    this.capability = capability;
    this.trackedIn = options.trackedIn;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  protected override serializeDetails(): JsonObject {
    return compactDetails({ capability: this.capability, trackedIn: this.trackedIn });
  }
}

/** Every concrete error code, used to validate an inbound serialization. */
const KNOWN_CODES: readonly OmnisErrorCode[] = Object.values(ERROR_CODES);

/**
 * Rebuilds an {@link OmnisError} from its serialized form.
 *
 * The round-trip is faithful for classification, message, metadata, retryability
 * and every class-specific field contributed by `serializeDetails()`. It is
 * intentionally lossy for the *cause chain*: a rebuilt error carries the
 * serialized cause inside `metadata.cause` rather than as a live `Error.cause`,
 * because reconstructing arbitrary foreign error objects across a boundary is
 * neither possible nor safe.
 */
export function omnisErrorFromSerialized(serialized: SerializedOmnisError): OmnisError {
  const metadata = serialized.metadata;
  const shared: OmnisErrorOptions = {
    metadata,
    retryable: serialized.retryable,
    retryAfterMs: serialized.retryAfterMs,
  };

  switch (serialized.code) {
    case ERROR_CODES.validationFailed:
      return new ValidationError(serialized.message, {
        ...shared,
        issues: readIssues(metadata),
      });
    case ERROR_CODES.configurationInvalid:
      return new ConfigurationError(serialized.message, {
        ...shared,
        keys: readStringArray(metadata, "keys"),
      });
    case ERROR_CODES.notFound:
      return new NotFoundError(
        readString(metadata, "resourceType") ?? "resource",
        readString(metadata, "resourceId"),
        shared,
      );
    case ERROR_CODES.conflict:
      return new ConflictError(
        readString(metadata, "conflict") ?? "state",
        serialized.message,
        shared,
      );
    case ERROR_CODES.authenticationFailed:
      return new AuthenticationError(serialized.message, shared);
    case ERROR_CODES.authorizationFailed:
      return new AuthorizationError(serialized.message, {
        ...shared,
        permission: readString(metadata, "permission"),
      });
    case ERROR_CODES.policyViolation:
      return new PolicyViolationError(
        readString(metadata, "policyId") ?? "unknown-policy",
        serialized.message,
        {
          ...shared,
          rule: readString(metadata, "rule"),
          requiresApproval: readBoolean(metadata, "requiresApproval"),
        },
      );
    case ERROR_CODES.providerFailure:
      return new ProviderError(
        readString(metadata, "providerKind") ?? "unknown",
        serialized.message,
        {
          ...shared,
          providerRef: readString(metadata, "providerRef"),
          providerStatus: readString(metadata, "providerStatus"),
        },
      );
    case ERROR_CODES.executionFailed:
      return new ExecutionError(serialized.message, {
        ...shared,
        executionId: readString(metadata, "executionId"),
      });
    case ERROR_CODES.timeout:
      return new TimeoutError(serialized.message, {
        ...shared,
        timeoutMs: readNumber(metadata, "timeoutMs"),
        operation: readString(metadata, "operation"),
      });
    case ERROR_CODES.infrastructureFailure:
      return new InfrastructureError(
        readString(metadata, "component") ?? "unknown",
        serialized.message,
        shared,
      );
    case ERROR_CODES.contractViolation:
      return new ContractError(
        readString(metadata, "contractId") ?? "unknown-contract",
        serialized.message,
        {
          ...shared,
          contractVersion: readString(metadata, "contractVersion"),
          receivedVersion: readString(metadata, "receivedVersion"),
        },
      );
    case ERROR_CODES.notImplemented:
      return new NotImplementedError(readString(metadata, "capability") ?? "unknown", {
        ...shared,
        trackedIn: readString(metadata, "trackedIn"),
      });
    default:
      return new OmnisError(
        KNOWN_CODES.includes(serialized.code) ? serialized.code : ERROR_CODES.unknown,
        serialized.message,
        shared,
      );
  }
}

function readString(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(metadata: JsonObject, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(metadata: JsonObject, key: string): boolean | undefined {
  const value = metadata[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(metadata: JsonObject, key: string): string[] | undefined {
  const value = metadata[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readIssues(metadata: JsonObject): ValidationIssue[] | undefined {
  const value = metadata["issues"];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const issues: ValidationIssue[] = [];
  for (const entry of value) {
    // Arrays are JSON objects too, but they are never a valid issue record.
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as JsonObject;
    const path = candidate["path"];
    const code = candidate["code"];
    const message = candidate["message"];
    if (typeof path !== "string" || typeof code !== "string" || typeof message !== "string") {
      continue;
    }
    issues.push({ path, code, message, received: candidate["received"] ?? null });
  }
  return issues.length > 0 ? issues : undefined;
}
