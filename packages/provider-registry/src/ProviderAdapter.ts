/**
 * The adapter side of the provider contract.
 *
 * The {@link ProviderAdapter} interface itself lives in `@omnis/ai-core-types`, because
 * both the registry and the orchestrator depend on it and neither may depend on the
 * other. What lives here is the *verification* of an adapter at registration time.
 *
 * Verifying at registration rather than at first invocation matters: an adapter missing
 * `invoke`, or declaring a different provider than the one it is being registered for,
 * would otherwise fail in the middle of an execution — after policy had been evaluated,
 * budget reserved and a deadline started. Failing at registration turns that into a
 * deployment error, which is where it belongs.
 */

import type { ModelCapability, ModelId, ProviderAdapter, ProviderId } from "@omnis/ai-core-types";
import { adapterProviderMismatch, invalidProviderAdapter } from "./errors.js";

export type { ProviderAdapter } from "@omnis/ai-core-types";

/** Structural check: does this value satisfy the adapter contract? */
export function isProviderAdapter(value: unknown): value is ProviderAdapter {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ProviderAdapter>;
  return (
    typeof candidate.providerId === "string" &&
    candidate.providerId.length > 0 &&
    typeof candidate.slug === "string" &&
    candidate.slug.length > 0 &&
    typeof candidate.invoke === "function" &&
    typeof candidate.supports === "function" &&
    (candidate.stream === undefined || typeof candidate.stream === "function") &&
    (candidate.dispose === undefined || typeof candidate.dispose === "function")
  );
}

/**
 * Asserts the adapter contract, and that it belongs to the provider being registered.
 *
 * @param expectedProviderId When given, the adapter must declare exactly this provider.
 */
export function assertProviderAdapter(
  adapter: unknown,
  expectedProviderId: ProviderId | null = null,
): ProviderAdapter {
  if (!isProviderAdapter(adapter)) {
    throw invalidProviderAdapter("value does not satisfy the ProviderAdapter contract", {
      hasInvoke: typeof (adapter as Partial<ProviderAdapter> | null)?.invoke,
      hasSupports: typeof (adapter as Partial<ProviderAdapter> | null)?.supports,
    });
  }
  if (expectedProviderId !== null && adapter.providerId !== expectedProviderId) {
    throw adapterProviderMismatch(adapter.providerId, expectedProviderId);
  }
  return adapter;
}

/**
 * True when the adapter claims every capability for the given model.
 *
 * `modelId` is required by the adapter contract, because "supports streaming" is a
 * statement about a *model* on a provider, not about the provider alone: one endpoint
 * commonly serves both a streaming and a non-streaming model.
 */
export function adapterSupportsAll(
  adapter: ProviderAdapter,
  capabilities: readonly ModelCapability[],
  modelId: ModelId,
): boolean {
  return capabilities.every((capability) => adapter.supports(capability, modelId));
}

/** A short, log-safe rendering of an adapter. Never includes anything it holds. */
export function describeAdapter(adapter: ProviderAdapter): string {
  return `adapter(${adapter.slug}, provider=${adapter.providerId}, streaming=${String(adapter.stream !== undefined)})`;
}
