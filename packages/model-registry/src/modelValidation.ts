/**
 * Runtime validation for model registration and lookup.
 *
 * The registry is a trust boundary: descriptors arrive from configuration files, an
 * admin API and — later — provider discovery. TypeScript's types are erased at runtime,
 * so the shapes are re-established here with the platform's single validation
 * technology (`z` re-exported by `@omnis/validation`; importing `zod` directly is
 * forbidden outside that package).
 *
 * What is validated is *shape and range*, not meaning. "This model has a 128 000 token
 * context window" is accepted as a claim; whether the provider honors it is discovered
 * by execution.
 */

import {
  describeSchema,
  identifierSchemas,
  jsonObjectSchema,
  nonEmptyStringSchema,
  z,
} from "@omnis/validation";
import {
  AI_CORE_CONTRACT_VERSION,
  LATENCY_CLASSES,
  MODEL_CAPABILITIES,
  MODEL_KINDS,
  MODEL_STATUSES,
  MODALITIES,
  SLUG_CONTRACT,
  SLUG_PATTERN,
} from "@omnis/ai-core-types";
import type {
  LatencyClass,
  ModelCapability,
  ModelDescriptor,
  ModelKind,
  ModelPricing,
  ModelStatus,
  Modality,
} from "@omnis/ai-core-types";

/**
 * A model slug, using the pattern shared by every AI Core registry.
 *
 * Slugs appear in configuration, in API paths and in logs, so the character set is
 * deliberately boring and identical to a provider slug: an operator should not have to
 * remember which registry they are talking to. {@link SLUG_PATTERN} documents the shape
 * and the reason a trailing separator is rejected.
 */
export const MODEL_SLUG_PATTERN = SLUG_PATTERN;

/** Schema for a model slug. */
export const modelSlugSchema = z.string().regex(MODEL_SLUG_PATTERN, {
  message: `model slug ${SLUG_CONTRACT}`,
});

/** Schema for one model capability. */
export const modelCapabilitySchema = z.enum(MODEL_CAPABILITIES);

/** Schema for one model kind. */
export const modelKindSchema = z.enum(MODEL_KINDS);

/** Schema for one model status. */
export const modelStatusSchema = z.enum(MODEL_STATUSES);

/** Schema for one modality. */
export const modalitySchema = z.enum(MODALITIES);

/** Schema for one latency class. */
export const latencyClassSchema = z.enum(LATENCY_CLASSES);

/** A non-negative integer token count. `0` means "unknown", which is a legal claim. */
const tokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Pricing, in integer micro-USD.
 *
 * Fractions are rejected rather than rounded: a price of 1.5 micro-USD cannot be
 * represented in the ledger, and rounding it here would silently change what the Budget
 * Engine charges.
 */
export const modelPricingSchema = z.object({
  currency: z.literal("micro_usd"),
  inputPerThousandTokens: z.number().int().nonnegative(),
  outputPerThousandTokens: z.number().int().nonnegative(),
  cachedInputPerThousandTokens: z.number().int().nonnegative().nullable(),
  perRequestMicro: z.number().int().nonnegative().nullable(),
});

/** Schema for a complete, registered model descriptor. */
export const modelDescriptorSchema = z.object({
  id: identifierSchemas.model,
  slug: modelSlugSchema,
  displayName: nonEmptyStringSchema,
  providerId: identifierSchemas.provider,
  kind: modelKindSchema,
  status: modelStatusSchema,
  capabilities: z.array(modelCapabilitySchema).min(1),
  modalities: z.object({
    input: z.array(modalitySchema),
    output: z.array(modalitySchema),
  }),
  contextWindowTokens: tokenCountSchema,
  maxOutputTokens: tokenCountSchema,
  pricing: modelPricingSchema.nullable(),
  priority: z.number().int().min(0).max(1_000_000),
  latencyClass: latencyClassSchema,
  providerModelName: nonEmptyStringSchema,
  version: z.number().int().positive(),
  metadata: jsonObjectSchema,
  registeredAt: z.string().datetime(),
});

/**
 * Schema for a registration request.
 *
 * Everything the registry assigns itself — the identifier, the version and, by default,
 * the registration timestamp — is optional here and required on the descriptor. That
 * split is what makes "the registry owns identity and versioning" enforceable rather
 * than a convention: a caller cannot register a descriptor claiming to be version 7.
 */
export const modelRegistrationInputSchema = z.object({
  id: identifierSchemas.model.optional(),
  slug: modelSlugSchema,
  displayName: nonEmptyStringSchema,
  providerId: identifierSchemas.provider,
  kind: modelKindSchema,
  status: modelStatusSchema.optional(),
  capabilities: z.array(modelCapabilitySchema).min(1),
  modalities: z.object({
    input: z.array(modalitySchema).min(1),
    output: z.array(modalitySchema).min(1),
  }),
  contextWindowTokens: tokenCountSchema.optional(),
  maxOutputTokens: tokenCountSchema.optional(),
  pricing: modelPricingSchema.nullable().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  latencyClass: latencyClassSchema.optional(),
  providerModelName: nonEmptyStringSchema,
  metadata: jsonObjectSchema.optional(),
  registeredAt: z.string().datetime().optional(),
});

/** Schema for a model reference: the three ways a caller may name a model. */
export const modelReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("id"), modelId: identifierSchemas.model }),
  z.object({
    kind: z.literal("slug"),
    slug: modelSlugSchema,
    providerId: identifierSchemas.provider.nullable(),
  }),
  z.object({
    kind: z.literal("capability"),
    capability: modelCapabilitySchema,
    modelKind: modelKindSchema.nullable(),
    providerId: identifierSchemas.provider.nullable(),
    minContextWindowTokens: tokenCountSchema,
    minMaxOutputTokens: tokenCountSchema,
  }),
]);

/** Schema for a registry query. */
export const modelQuerySchema = z.object({
  capabilities: z.array(modelCapabilitySchema).optional(),
  inputModalities: z.array(modalitySchema).optional(),
  outputModalities: z.array(modalitySchema).optional(),
  providerId: identifierSchemas.provider.nullish(),
  kind: modelKindSchema.nullish(),
  statuses: z.array(modelStatusSchema).optional(),
  minContextWindowTokens: tokenCountSchema.optional(),
  minMaxOutputTokens: tokenCountSchema.optional(),
  limit: z.number().int().positive().max(1_000).optional(),
});

/** The registration input shape, as validated. */
export interface ModelRegistrationInput {
  readonly id?: ModelDescriptor["id"];
  readonly slug: string;
  readonly displayName: string;
  readonly providerId: ModelDescriptor["providerId"];
  readonly kind: ModelKind;
  readonly status?: ModelStatus;
  readonly capabilities: readonly ModelCapability[];
  readonly modalities: {
    readonly input: readonly Modality[];
    readonly output: readonly Modality[];
  };
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly pricing?: ModelPricing | null;
  readonly priority?: number;
  readonly latencyClass?: LatencyClass;
  readonly providerModelName: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly registeredAt?: string;
}

/** A registry query, as validated. */
export interface ModelQueryInput {
  readonly capabilities?: readonly ModelCapability[];
  readonly inputModalities?: readonly Modality[];
  readonly outputModalities?: readonly Modality[];
  readonly providerId?: ModelDescriptor["providerId"] | null;
  readonly kind?: ModelKind | null;
  readonly statuses?: readonly ModelStatus[];
  readonly minContextWindowTokens?: number;
  readonly minMaxOutputTokens?: number;
  readonly limit?: number;
}

/** The descriptor contract, with a stable identity for error messages. */
export const MODEL_DESCRIPTOR_CONTRACT = describeSchema(
  "ModelDescriptor",
  modelDescriptorSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The registration contract. */
export const MODEL_REGISTRATION_CONTRACT = describeSchema(
  "ModelRegistration",
  modelRegistrationInputSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** True when the value is a well-formed model slug. */
export function isModelSlug(value: string): boolean {
  return MODEL_SLUG_PATTERN.test(value);
}
