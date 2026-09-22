/**
 * The orchestrator's typed errors.
 *
 * Every one of them is an `OmnisError` subclass from `@omnis/errors`, so a caller can catch one
 * type and still read `code`, `retryable` and `metadata`. None of them carries message content,
 * model output or a credential: an error message ends up in logs, in an audit row and sometimes in
 * an API response, and a prompt in any of those is a leak.
 */

import { ConflictError, NotImplementedError, NotFoundError } from "@omnis/errors";
import type { ModelId, ModelReference, ProviderId } from "@omnis/ai-core-types";
import { describeModelReference } from "@omnis/ai-core-types";

/** No registered model matches the reference the caller made. */
export function noModelForReference(reference: ModelReference): NotFoundError {
  return new NotFoundError("model", describeModelReference(reference), {
    retryable: false,
    metadata: { registry: "orchestrator", reference: describeModelReference(reference) },
  });
}

/**
 * No provider could serve the call, after every candidate was tried.
 *
 * Marked non-retryable: the orchestrator has already exhausted the candidates it was given, so
 * repeating this call would repeat the same walk. Retrying means making a new call, later, when
 * provider health has changed — which `details.candidatesTried` and `details.reason` let a caller
 * judge for itself.
 */
export function noProviderAvailable(
  reference: ModelReference,
  tried: number,
  reason: string,
): NotFoundError {
  return new NotFoundError("provider", describeModelReference(reference), {
    retryable: false,
    metadata: {
      registry: "orchestrator",
      reference: describeModelReference(reference),
      candidatesTried: tried,
      reason,
    },
  });
}

/** The adapter for a provider is not registered, or refused the capability. */
export function providerNotServable(providerId: ProviderId, reason: string): ConflictError {
  return new ConflictError(
    `provider:${providerId}`,
    `provider ${providerId} cannot serve this call: ${reason}`,
    {
      retryable: false,
      metadata: { registry: "orchestrator", providerId, reason },
    },
  );
}

/** Streaming was asked for and nothing in the chain can do it. */
export function streamingUnsupported(
  providerId: ProviderId,
  modelId: ModelId,
): NotImplementedError {
  return new NotImplementedError("model.stream", {
    retryable: false,
    metadata: {
      registry: "orchestrator",
      providerId,
      modelId,
      reason: "the adapter does not implement stream",
    },
  });
}
