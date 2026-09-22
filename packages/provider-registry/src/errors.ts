/**
 * Provider Registry errors.
 *
 * Factories over the platform hierarchy, as in the Model Registry: the classes, codes,
 * redaction and serialization belong to `@omnis/errors`, and what this module adds is the
 * provider-specific context that makes a failure actionable — which provider, which
 * adapter, which capability was missing.
 */

import { ConflictError, ContractError, NotFoundError, ValidationError } from "@omnis/errors";
import type { ValidationIssue } from "@omnis/errors";
import { describeModelReference } from "@omnis/ai-core-types";
import type { ModelCapability, ModelReference, ProviderOperation } from "@omnis/ai-core-types";
import type { ProviderId } from "@omnis/ai-core-types";

/** A provider identifier that is not registered. */
export function providerNotRegistered(providerId: ProviderId): NotFoundError {
  return new NotFoundError("provider", providerId, {
    retryable: false,
    metadata: { providerId, registry: "provider" },
  });
}

/** A slug that is already registered. */
export function duplicateProviderSlug(slug: string, existingProviderId: ProviderId): ConflictError {
  return new ConflictError(`provider:${slug}`, `provider slug "${slug}" is already registered`, {
    retryable: false,
    metadata: { slug, existingProviderId, registry: "provider" },
  });
}

/** An identifier that is already registered. */
export function duplicateProviderId(providerId: ProviderId): ConflictError {
  return new ConflictError(
    `provider:${providerId}`,
    `provider identifier "${providerId}" is already registered`,
    {
      retryable: false,
      metadata: { providerId, registry: "provider" },
    },
  );
}

/**
 * An adapter that does not satisfy the {@link ProviderAdapter} contract.
 *
 * Checked at registration rather than at first invocation: an adapter missing `invoke`
 * would otherwise fail in the middle of an execution, after policy and budget had
 * already been consumed.
 */
export function invalidProviderAdapter(
  reason: string,
  details: Record<string, unknown> = {},
): ContractError {
  return new ContractError("provider-adapter", `provider adapter is invalid: ${reason}`, {
    retryable: false,
    metadata: { reason, ...details, registry: "provider" },
  });
}

/** An adapter whose declared provider disagrees with the registration. */
export function adapterProviderMismatch(
  adapterProviderId: string,
  descriptorProviderId: ProviderId,
): ContractError {
  return new ContractError(
    "provider-adapter",
    "adapter provider identifier does not match the registration",
    {
      retryable: false,
      metadata: { adapterProviderId, descriptorProviderId, registry: "provider" },
    },
  );
}

/** No registered provider can serve the requested work. */
export function noProviderForCapability(
  capability: ModelCapability,
  reason: string,
): NotFoundError {
  return new NotFoundError("provider-capability", capability, {
    retryable: true,
    metadata: { capability, reason, registry: "provider" },
  });
}

/** No registered provider can serve the referenced model. */
export function noProviderForModel(reference: ModelReference, reason: string): NotFoundError {
  return new NotFoundError("provider-model", describeModelReference(reference), {
    retryable: true,
    metadata: { modelReference: describeModelReference(reference), reason, registry: "provider" },
  });
}

/** A provider that exists but cannot currently serve work. */
export function providerNotSelectable(
  providerId: ProviderId,
  status: string,
  health: string,
): ConflictError {
  return new ConflictError(
    `provider:${providerId}`,
    `provider cannot be selected (status=${status}, health=${health})`,
    {
      retryable: true,
      metadata: { providerId, status, health, registry: "provider" },
    },
  );
}

/** A status transition the registry does not allow. */
export function invalidProviderStatusTransition(
  slug: string,
  from: string,
  to: string,
): ValidationError {
  return new ValidationError(`provider "${slug}" cannot move from ${from} to ${to}`, {
    retryable: false,
    issues: [
      {
        path: "status",
        code: "invalid_transition",
        message: `${from} -> ${to} is not allowed`,
        received: to,
      },
    ],
    metadata: { slug, from, to, registry: "provider" },
  });
}

/** A registration input that failed schema validation. */
export function invalidProviderRegistration(
  summary: string,
  issues: readonly ValidationIssue[],
): ValidationError {
  return new ValidationError(`provider registration failed: ${summary}`, {
    retryable: false,
    issues,
    metadata: { registry: "provider" },
  });
}

/** The registry has reached its configured capacity. */
export function providerRegistryCapacityExceeded(capacity: number): ConflictError {
  return new ConflictError(
    "provider-registry-capacity",
    `provider registry is full at ${String(capacity)} entries`,
    {
      retryable: false,
      metadata: { capacity, registry: "provider" },
    },
  );
}

/** A requested operation is not supported by any registered provider. */
export function operationNotSupported(operation: ProviderOperation): NotFoundError {
  return new NotFoundError("provider-operation", operation, {
    retryable: false,
    metadata: { operation, registry: "provider" },
  });
}
