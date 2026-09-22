/**
 * Model contracts.
 *
 * A model in OMNIS is *not* a vendor endpoint. It is a registered capability
 * offering: something the system can address by identifier, by slug or by what it
 * can do, and that the Model Orchestrator can later bind to a concrete provider.
 * Keeping that indirection is what allows a character's "voice" or an agent's
 * "reasoning model" to survive a vendor change, a price change or an outage.
 *
 * Design rules enforced by the shapes below:
 * - `ModelReference` is a discriminated union, never a bare string. A bare string
 *   cannot say whether it is an identifier, a slug or a capability request, and the
 *   three resolve through completely different code paths.
 * - Limits are numbers with an explicit "unknown" value of `0`, never `undefined`.
 *   `undefined` would silently mean "unlimited" at every comparison site.
 * - Pricing is optional and denominated in integer micro-USD. Inventing a price for
 *   a model whose pricing is unknown would produce a confident, wrong budget check.
 */

import type { JsonValue } from "@omnis/types";
import type { AiCoreMetadata } from "./constants.js";
import type { ModelId, ProviderId } from "./identifiers.js";

/** What a model can do, independent of who serves it. */
export const MODEL_CAPABILITIES = [
  "chat",
  "streaming",
  "tool_calling",
  "structured_output",
  "vision",
  "audio_input",
  "audio_output",
  "embeddings",
  "reasoning",
  "batch",
] as const;

/** One capability a model may advertise. */
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** True when the value names a known model capability. */
export function isModelCapability(value: string): value is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

/** The shape of work a model is built for. Drives selection and cost expectations. */
export const MODEL_KINDS = [
  "general",
  "reasoning",
  "fast",
  "vision",
  "speech",
  "embedding",
  "image",
  "video",
  "custom",
] as const;

/** A model's declared purpose. */
export type ModelKind = (typeof MODEL_KINDS)[number];

/** A content modality a model can accept or emit. */
export const MODALITIES = ["text", "image", "audio", "video", "embedding", "file"] as const;

/** One content modality. */
export type Modality = (typeof MODALITIES)[number];

/**
 * Lifecycle status of a registered model.
 *
 * `degraded` is distinct from `unavailable`: a degraded model may still be selected
 * when nothing better exists, but ranks below healthy candidates. Collapsing the two
 * would either hide a struggling model or take it out of service entirely.
 */
export const MODEL_STATUSES = ["available", "preview", "degraded", "retired"] as const;

/** Lifecycle status of a model descriptor. */
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** True when a model with this status may be selected for new work. */
export function isSelectableModelStatus(status: ModelStatus): boolean {
  return status === "available" || status === "preview" || status === "degraded";
}

/** Coarse latency band, used for selection tie-breaks and evaluation. */
export const LATENCY_CLASSES = ["low", "medium", "high", "unknown"] as const;

/** A coarse latency band. Exact latency is measured, never declared. */
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

/**
 * Pricing in integer micro-USD per thousand tokens.
 *
 * `null` at the descriptor level means "unknown", which the Budget Engine treats as
 * "cannot cost this call" rather than "free" — see `budget.ts`.
 */
export interface ModelPricing {
  /** Always `micro_usd`: the currency is part of the shape so it cannot be misread. */
  readonly currency: "micro_usd";
  /** Integer micro-USD per 1 000 input tokens. */
  readonly inputPerThousandTokens: number;
  /** Integer micro-USD per 1 000 output tokens. */
  readonly outputPerThousandTokens: number;
  /** Integer micro-USD per 1 000 cached input tokens, when the provider discounts them. */
  readonly cachedInputPerThousandTokens: number | null;
  /** Integer micro-USD charged per request regardless of tokens, when applicable. */
  readonly perRequestMicro: number | null;
}

/** How a caller may name the model it wants. */
export type ModelReference =
  | {
      /** An exact registered model. */
      readonly kind: "id";
      readonly modelId: ModelId;
    }
  | {
      /** A stable slug, optionally scoped to one provider. */
      readonly kind: "slug";
      readonly slug: string;
      readonly providerId: ProviderId | null;
    }
  | {
      /**
       * A capability request: "give me something that can do this".
       *
       * Resolution is deterministic — see `ModelQuery` — because a capability
       * request that resolves differently on two runs would make execution
       * non-reproducible and would let a routing change silently alter behavior.
       */
      readonly kind: "capability";
      readonly capability: ModelCapability;
      readonly modelKind: ModelKind | null;
      readonly providerId: ProviderId | null;
      /** Minimum context window required, in tokens. `0` means no requirement. */
      readonly minContextWindowTokens: number;
      /** Minimum output ceiling required, in tokens. `0` means no requirement. */
      readonly minMaxOutputTokens: number;
    };

/** Builds a reference to an exact model identifier. */
export function modelById(modelId: ModelId): ModelReference {
  return Object.freeze({ kind: "id", modelId });
}

/** Builds a reference to a model slug, optionally scoped to a provider. */
export function modelBySlug(slug: string, providerId: ProviderId | null = null): ModelReference {
  return Object.freeze({ kind: "slug", slug, providerId });
}

/** Builds a capability request. */
export function modelByCapability(
  capability: ModelCapability,
  options: {
    readonly modelKind?: ModelKind | null;
    readonly providerId?: ProviderId | null;
    readonly minContextWindowTokens?: number;
    readonly minMaxOutputTokens?: number;
  } = {},
): ModelReference {
  return Object.freeze({
    kind: "capability",
    capability,
    modelKind: options.modelKind ?? null,
    providerId: options.providerId ?? null,
    minContextWindowTokens: options.minContextWindowTokens ?? 0,
    minMaxOutputTokens: options.minMaxOutputTokens ?? 0,
  });
}

/** True when the value names a known model kind. */
export function isModelKind(value: string): value is ModelKind {
  return (MODEL_KINDS as readonly string[]).includes(value);
}

/**
 * True when the value is a well-formed {@link ModelReference}.
 *
 * A reference crosses a trust boundary every time a request enters the platform: from an API
 * caller, from a stored agent descriptor, from a plan built by another component. Checking it
 * here — once, next to the type it guards — is what keeps those boundaries from each inventing
 * their own idea of what a reference looks like.
 */
export function isModelReference(value: unknown): value is ModelReference {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  switch (reference["kind"]) {
    case "id":
      return typeof reference["modelId"] === "string" && reference["modelId"].length > 0;
    case "slug":
      return (
        typeof reference["slug"] === "string" &&
        reference["slug"].length > 0 &&
        (reference["providerId"] === null || typeof reference["providerId"] === "string")
      );
    case "capability":
      return (
        typeof reference["capability"] === "string" &&
        isModelCapability(reference["capability"]) &&
        (reference["modelKind"] === null ||
          (typeof reference["modelKind"] === "string" && isModelKind(reference["modelKind"]))) &&
        (reference["providerId"] === null || typeof reference["providerId"] === "string") &&
        isNonNegativeNumber(reference["minContextWindowTokens"]) &&
        isNonNegativeNumber(reference["minMaxOutputTokens"])
      );
    default:
      return false;
  }
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A stable, human-readable rendering of a reference, safe to log and to use as a map key. */
export function describeModelReference(reference: ModelReference): string {
  switch (reference.kind) {
    case "id":
      return `id:${reference.modelId}`;
    case "slug":
      return reference.providerId === null
        ? `slug:${reference.slug}`
        : `slug:${reference.slug}@${reference.providerId}`;
    case "capability": {
      const scope = reference.providerId === null ? "" : `@${reference.providerId}`;
      const kind = reference.modelKind === null ? "" : `:${reference.modelKind}`;
      return `capability:${reference.capability}${kind}${scope}`;
    }
  }
}

/** Modality support declared by a model. */
export interface ModelModalities {
  readonly input: readonly Modality[];
  readonly output: readonly Modality[];
}

/**
 * An immutable, registered description of one model offering.
 *
 * Deep-frozen by the registry at registration: a descriptor that could be mutated in
 * place would make selection results depend on who last touched the registry, and
 * would invalidate every audit record that referenced it.
 */
export interface ModelDescriptor {
  readonly id: ModelId;
  /** Stable human-facing key, unique within a registry. Slugs survive model upgrades; ids do not change either, but slugs are what configs reference. */
  readonly slug: string;
  readonly displayName: string;
  readonly providerId: ProviderId;
  readonly kind: ModelKind;
  readonly status: ModelStatus;
  readonly capabilities: readonly ModelCapability[];
  readonly modalities: ModelModalities;
  /** Total context window in tokens. `0` means unknown, which selection treats as "cannot satisfy a minimum". */
  readonly contextWindowTokens: number;
  /** Maximum output tokens the model will emit. `0` means unknown. */
  readonly maxOutputTokens: number;
  /** Pricing, or `null` when unknown. Never estimated. */
  readonly pricing: ModelPricing | null;
  /**
   * Selection preference: lower is preferred.
   *
   * An explicit integer rather than an implicit ordering, so tie-breaks are
   * deterministic and reviewable instead of depending on registration order.
   */
  readonly priority: number;
  readonly latencyClass: LatencyClass;
  /** Vendor-facing model name sent on the wire by the provider adapter. */
  readonly providerModelName: string;
  /** Descriptor revision, incremented on re-registration with changed fields. */
  readonly version: number;
  readonly metadata: AiCoreMetadata;
  readonly registeredAt: string;
}

/** True when the descriptor advertises every capability in `required`. */
export function modelSatisfiesCapabilities(
  descriptor: ModelDescriptor,
  required: readonly ModelCapability[],
): boolean {
  return required.every((capability) => descriptor.capabilities.includes(capability));
}

/** True when the descriptor accepts every input modality and emits every output modality. */
export function modelSatisfiesModalities(
  descriptor: ModelDescriptor,
  input: readonly Modality[],
  output: readonly Modality[],
): boolean {
  return (
    input.every((modality) => descriptor.modalities.input.includes(modality)) &&
    output.every((modality) => descriptor.modalities.output.includes(modality))
  );
}

/** True when the descriptor is selectable and meets the reference's minimums. */
export function modelMatchesReference(
  descriptor: ModelDescriptor,
  reference: ModelReference,
): boolean {
  if (!isSelectableModelStatus(descriptor.status)) {
    return false;
  }
  switch (reference.kind) {
    case "id":
      return descriptor.id === reference.modelId;
    case "slug":
      return (
        descriptor.slug === reference.slug &&
        (reference.providerId === null || descriptor.providerId === reference.providerId)
      );
    case "capability":
      return (
        descriptor.capabilities.includes(reference.capability) &&
        (reference.modelKind === null || descriptor.kind === reference.modelKind) &&
        (reference.providerId === null || descriptor.providerId === reference.providerId) &&
        descriptor.contextWindowTokens >= reference.minContextWindowTokens &&
        descriptor.maxOutputTokens >= reference.minMaxOutputTokens
      );
  }
}

/**
 * Deterministic ordering for candidate models.
 *
 * Priority first, then capability breadth (more capable wins a tie only when it does
 * not cost priority), then slug as the final total-order tie-break so two runs over
 * the same registry always produce the same winner.
 */
export function compareModelDescriptors(left: ModelDescriptor, right: ModelDescriptor): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  if (left.capabilities.length !== right.capabilities.length) {
    return right.capabilities.length - left.capabilities.length;
  }
  if (left.slug !== right.slug) {
    return left.slug < right.slug ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** A caller-supplied generation parameter set. Every field is optional and bounded. */
export interface ModelParameters {
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly maxOutputTokens: number | null;
  readonly stop: readonly string[];
  readonly seed: number | null;
  /**
   * Requested response format.
   *
   * `json_schema` is only honored when the model advertises `structured_output`;
   * the orchestrator rejects the mismatch instead of silently downgrading, because a
   * caller asking for schema-constrained output that receives prose has a bug, not a
   * fallback.
   */
  readonly responseFormat: ResponseFormat | null;
}

/** The response shape a caller asks for. */
export type ResponseFormat =
  | { readonly type: "text" }
  | { readonly type: "json_object" }
  | { readonly type: "json_schema"; readonly name: string; readonly schema: JsonValue };

/** A {@link ModelParameters} with every field unset. */
export const DEFAULT_MODEL_PARAMETERS: ModelParameters = Object.freeze({
  temperature: null,
  topP: null,
  maxOutputTokens: null,
  stop: Object.freeze([]),
  seed: null,
  responseFormat: null,
});
