/**
 * Provider selection.
 *
 * Selection answers one question: *given the work to be done and everything currently
 * known about the endpoints, in what order should we try them?* It is a pure function of
 * the registered descriptors, their observed health and the request — no clock, no
 * randomness, no round-robin counter. That is what makes the fallback order testable and
 * an incident reconstructible: with the same registry state and the same request, the
 * same provider is chosen, every time.
 *
 * Two stages, deliberately separate:
 * 1. **Eligibility** — hard filters. A provider that is disabled, unavailable, denied by
 *    policy, missing a required capability, in the wrong region or too expensive is not a
 *    candidate at all. Filters produce a *reason*, which is recorded so an operator can
 *    see why nothing was selected.
 * 2. **Ranking** — a weighted score over the survivors, then a total-order tie-break
 *    (`compareProviderCandidates`) so equal scores still produce one stable order.
 *
 * Scoring never invents facts. Cost is only considered when the caller supplies it, which
 * in practice means the orchestrator passed the selected model's declared pricing. A
 * provider whose cost is unknown is ranked as if unconstrained but records that its cost
 * was unknown — guessing a price would silently bias routing.
 */

import { compareProviderCandidates, isSelectableProviderStatus } from "@omnis/ai-core-types";
import type {
  ModelCapability,
  ModelId,
  ProviderAdapter,
  ProviderCandidate,
  ProviderDescriptor,
  ProviderHealth,
  ProviderId,
  ProviderOperation,
} from "@omnis/ai-core-types";
import { MAX_FALLBACK_CANDIDATES } from "@omnis/ai-core-types";
import { isSelectableHealthState } from "./ProviderHealth.js";

/** Score contributions. Integers, so a score is exactly reproducible. */
export const SELECTION_WEIGHTS = {
  /** Provider status is `ready`. */
  statusReady: 40,
  /** Provider status is `degraded`: still eligible, but ranked below ready providers. */
  statusDegraded: 10,
  /** Observed health is healthy. */
  healthHealthy: 30,
  /** No observations yet: eligible, ranked between healthy and degraded. */
  healthUnknown: 15,
  /** Observed health is degraded. */
  healthDegraded: 5,
  /**
   * Ceiling used to turn "lower priority is better" into "higher score is better".
   * A provider with priority 0 scores the full ceiling; priority 250 scores zero.
   */
  priorityCeiling: 200,
  /** Declared cost is within the caller's ceiling. */
  costWithinBudget: 20,
  /** The adapter explicitly confirmed the capability for the requested model. */
  adapterConfirmed: 10,
} as const;

/** What the caller wants, and what governance allows. */
export interface ProviderSelectionRequest {
  /** Model capabilities the provider must serve. */
  readonly capabilities?: readonly ModelCapability[];
  /** Endpoint operations the provider must offer, e.g. `embeddings`. */
  readonly operations?: readonly ProviderOperation[];
  /** The model to be served, when known: enables the adapter's own capability check. */
  readonly modelId?: ModelId | null;
  /** Policy allow-list. `null` or omitted means unconstrained. */
  readonly allowedProviderIds?: readonly ProviderId[] | null;
  /** Policy deny-list. Applied after the allow-list. */
  readonly deniedProviderIds?: readonly ProviderId[] | null;
  /** Region allow-list, for data-residency constraints. */
  readonly regions?: readonly string[] | null;
  /**
   * Maximum acceptable declared cost, in integer micro-USD per thousand tokens.
   *
   * A provider whose cost is unknown is *not* excluded: unknown pricing is the normal
   * case for local and enterprise endpoints, and excluding them would make a cost
   * constraint silently remove half the fleet.
   */
  readonly maxCostMicroPerThousandTokens?: number | null;
  /** Declared cost per provider, supplied by the caller from model pricing. Never invented here. */
  readonly costs?: Readonly<Record<string, number>> | null;
  /** Maximum number of candidates to return. Bounded by `MAX_FALLBACK_CANDIDATES`. */
  readonly limit?: number;
}

/** A provider the selector may consider. */
export interface SelectableProvider {
  readonly descriptor: ProviderDescriptor;
  readonly health: ProviderHealth;
  readonly adapter: ProviderAdapter;
}

/** Why a provider was excluded, or the scored candidate it produced. */
export type ProviderSelectionOutcome =
  | { readonly selected: true; readonly candidate: ProviderCandidate }
  | { readonly selected: false; readonly providerId: ProviderId; readonly reason: string };

/** Scores one provider, or explains why it is not eligible. */
export function scoreProvider(
  provider: SelectableProvider,
  request: ProviderSelectionRequest = {},
): ProviderSelectionOutcome {
  const { descriptor, health, adapter } = provider;

  if (!isSelectableProviderStatus(descriptor.status)) {
    return excluded(descriptor.id, `status is ${descriptor.status}`);
  }
  if (!isSelectableHealthState(health.state)) {
    return excluded(descriptor.id, `health is ${health.state}`);
  }
  if (!descriptor.credentialsConfigured) {
    return excluded(descriptor.id, "credentials are not configured");
  }
  if (request.allowedProviderIds != null && !request.allowedProviderIds.includes(descriptor.id)) {
    return excluded(descriptor.id, "not in the policy allow-list");
  }
  if (request.deniedProviderIds != null && request.deniedProviderIds.includes(descriptor.id)) {
    return excluded(descriptor.id, "denied by policy");
  }
  if (request.regions != null && request.regions.length > 0) {
    if (descriptor.region === null || !request.regions.includes(descriptor.region)) {
      return excluded(descriptor.id, `region ${descriptor.region ?? "unknown"} is not permitted`);
    }
  }
  for (const operation of request.operations ?? []) {
    if (!descriptor.capabilities.operations.includes(operation)) {
      return excluded(descriptor.id, `operation ${operation} is not supported`);
    }
  }
  for (const capability of request.capabilities ?? []) {
    if (!descriptor.capabilities.modelCapabilities.includes(capability)) {
      return excluded(descriptor.id, `capability ${capability} is not declared`);
    }
  }

  const cost = request.costs?.[descriptor.id] ?? null;
  if (
    request.maxCostMicroPerThousandTokens != null &&
    cost !== null &&
    cost > request.maxCostMicroPerThousandTokens
  ) {
    return excluded(descriptor.id, `declared cost ${String(cost)} exceeds the limit`);
  }

  // The adapter's own answer is authoritative for a specific model: an endpoint may
  // serve streaming for one model and not another.
  let adapterConfirmed = false;
  for (const capability of request.capabilities ?? []) {
    if (request.modelId != null && !adapter.supports(capability, request.modelId)) {
      return excluded(
        descriptor.id,
        `adapter does not support ${capability} for the requested model`,
      );
    }
    if (request.modelId != null) {
      adapterConfirmed = true;
    }
  }

  const reasons: string[] = [];
  let score = 0;

  if (descriptor.status === "ready") {
    score += SELECTION_WEIGHTS.statusReady;
    reasons.push(`status=ready(+${String(SELECTION_WEIGHTS.statusReady)})`);
  } else {
    score += SELECTION_WEIGHTS.statusDegraded;
    reasons.push(`status=${descriptor.status}(+${String(SELECTION_WEIGHTS.statusDegraded)})`);
  }

  if (health.state === "healthy") {
    score += SELECTION_WEIGHTS.healthHealthy;
    reasons.push(`health=healthy(+${String(SELECTION_WEIGHTS.healthHealthy)})`);
  } else if (health.state === "unknown") {
    score += SELECTION_WEIGHTS.healthUnknown;
    reasons.push(`health=unknown(+${String(SELECTION_WEIGHTS.healthUnknown)})`);
  } else {
    score += SELECTION_WEIGHTS.healthDegraded;
    reasons.push(`health=degraded(+${String(SELECTION_WEIGHTS.healthDegraded)})`);
  }

  const priorityScore = Math.max(0, SELECTION_WEIGHTS.priorityCeiling - descriptor.priority);
  score += priorityScore;
  reasons.push(`priority=${String(descriptor.priority)}(+${String(priorityScore)})`);

  if (cost === null) {
    reasons.push("cost=unknown(+0)");
  } else if (request.maxCostMicroPerThousandTokens != null) {
    score += SELECTION_WEIGHTS.costWithinBudget;
    reasons.push(`cost=${String(cost)}(+${String(SELECTION_WEIGHTS.costWithinBudget)})`);
  } else {
    reasons.push(`cost=${String(cost)}(+0)`);
  }

  if (adapterConfirmed) {
    score += SELECTION_WEIGHTS.adapterConfirmed;
    reasons.push(`adapter=confirmed(+${String(SELECTION_WEIGHTS.adapterConfirmed)})`);
  }

  return {
    selected: true,
    candidate: Object.freeze({ descriptor, health, score, reasons: Object.freeze(reasons) }),
  };
}

/**
 * Scores and ranks every provider, returning the fallback order.
 *
 * The result is at most {@link MAX_FALLBACK_CANDIDATES} long unless the caller asks for
 * more, and never longer than the registry holds: an unbounded fallback list turns one
 * outage into a cascade, because the orchestrator would try every provider in turn
 * inside a single deadline.
 */
export function selectProviders(
  providers: readonly SelectableProvider[],
  request: ProviderSelectionRequest = {},
): readonly ProviderCandidate[] {
  const candidates: ProviderCandidate[] = [];
  for (const provider of providers) {
    const outcome = scoreProvider(provider, request);
    if (outcome.selected) {
      candidates.push(outcome.candidate);
    }
  }
  candidates.sort(compareProviderCandidates);
  // The default cap exists so one outage cannot turn into a cascade: the orchestrator
  // tries candidates in order inside a single deadline, and an unbounded list means
  // trying the whole fleet before giving up. An explicit limit may exceed it, because a
  // caller that asks for every candidate is making that choice deliberately.
  const limit = request.limit === undefined ? MAX_FALLBACK_CANDIDATES : Math.max(1, request.limit);
  return Object.freeze(candidates.slice(0, limit));
}

/** Explains why each provider was excluded, for logs, events and the Studio UI. */
export function explainExclusions(
  providers: readonly SelectableProvider[],
  request: ProviderSelectionRequest = {},
): Readonly<Record<string, string>> {
  const explanations: Record<string, string> = {};
  for (const provider of providers) {
    const outcome = scoreProvider(provider, request);
    if (!outcome.selected) {
      explanations[provider.descriptor.slug] = outcome.reason;
    }
  }
  return Object.freeze(explanations);
}

function excluded(providerId: ProviderId, reason: string): ProviderSelectionOutcome {
  return { selected: false, providerId, reason };
}
