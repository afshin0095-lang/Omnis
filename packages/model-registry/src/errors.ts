/**
 * Model Registry errors.
 *
 * Factories over the platform hierarchy rather than a new class tree: `@omnis/errors`
 * owns the thirteen OMNIS error classes, the closed code set, redaction and
 * serialization, and every consumer (HTTP mapping, retry classification, log
 * formatting) is written against them. What the registry adds is *context* — which
 * model, which slug, which reference failed to resolve — carried in metadata that
 * `classifyError` in `@omnis/ai-core-types` can read back.
 */

import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import type { ValidationIssue } from "@omnis/errors";
import { describeModelReference } from "@omnis/ai-core-types";
import type { ModelDescriptor, ModelId, ModelReference, ProviderId } from "@omnis/ai-core-types";

/** A model identifier that is not registered. */
export function modelNotRegistered(modelId: ModelId): NotFoundError {
  return new NotFoundError("model", modelId, {
    retryable: false,
    metadata: { modelId, registry: "model" },
  });
}

/** A model reference that resolved to nothing. */
export function modelNotResolvable(reference: ModelReference, reason: string): NotFoundError {
  return new NotFoundError("model", describeModelReference(reference), {
    retryable: false,
    metadata: { modelReference: describeModelReference(reference), reason, registry: "model" },
  });
}

/** A slug that is already registered, possibly to a different model. */
export function duplicateModelSlug(slug: string, existingModelId: ModelId): ConflictError {
  return new ConflictError(`model:${slug}`, `model slug "${slug}" is already registered`, {
    retryable: false,
    metadata: { slug, existingModelId, registry: "model" },
  });
}

/** An identifier that is already registered. */
export function duplicateModelId(modelId: ModelId): ConflictError {
  return new ConflictError(
    `model:${modelId}`,
    `model identifier "${modelId}" is already registered`,
    {
      retryable: false,
      metadata: { modelId, registry: "model" },
    },
  );
}

/** A model that exists but may not be used, e.g. because it is retired. */
export function modelNotSelectable(descriptor: ModelDescriptor, reason: string): ConflictError {
  return new ConflictError(
    `model:${descriptor.slug}`,
    `model "${descriptor.slug}" cannot be selected: ${reason}`,
    {
      retryable: false,
      metadata: {
        modelId: descriptor.id,
        slug: descriptor.slug,
        status: descriptor.status,
        reason,
        registry: "model",
      },
    },
  );
}

/** A provider that no model in the registry is served by. */
export function providerHasNoModels(providerId: ProviderId): NotFoundError {
  return new NotFoundError("provider-models", providerId, {
    retryable: false,
    metadata: { providerId, registry: "model" },
  });
}

/** The registry has reached its configured capacity. */
export function registryCapacityExceeded(capacity: number): ConflictError {
  return new ConflictError(
    "model-registry-capacity",
    `model registry is full at ${String(capacity)} entries`,
    {
      retryable: false,
      metadata: { capacity, registry: "model" },
    },
  );
}

/** A registration input that failed schema validation. */
export function invalidModelRegistration(
  summary: string,
  issues: readonly ValidationIssue[],
): ValidationError {
  return new ValidationError(`model registration failed: ${summary}`, {
    retryable: false,
    issues,
    metadata: { registry: "model" },
  });
}

/** A status transition the registry does not allow, e.g. reviving a retired model. */
export function invalidModelStatusTransition(
  slug: string,
  from: string,
  to: string,
): ValidationError {
  return new ValidationError(`model "${slug}" cannot move from ${from} to ${to}`, {
    retryable: false,
    issues: [
      {
        path: "status",
        code: "invalid_transition",
        message: `${from} -> ${to} is not allowed`,
        received: to,
      },
    ],
    metadata: { slug, from, to, registry: "model" },
  });
}
