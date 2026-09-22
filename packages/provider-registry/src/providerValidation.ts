/**
 * Runtime validation for provider registration and selection.
 *
 * Provider descriptors arrive from configuration and from an operator API, and they
 * decide where production traffic goes. Validating them at registration is cheaper than
 * discovering a malformed rate limit during an outage.
 *
 * Credentials are *never* part of a descriptor: the only credential-shaped field is the
 * boolean `credentialsConfigured`, so a descriptor can be logged, serialized into an
 * event and returned by an API without any possibility of publishing a secret.
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
  MODALITIES,
  PROVIDER_OPERATIONS,
  PROVIDER_STATUSES,
  TRANSPORT_KINDS,
} from "@omnis/ai-core-types";
import type {
  LatencyClass,
  ModelCapability,
  Modality,
  ProviderDescriptor,
  ProviderOperation,
  TransportKind,
} from "@omnis/ai-core-types";
import { SLUG_CONTRACT, SLUG_PATTERN } from "./slugPattern.js";

/** Schema for a provider slug. The same shape as a model slug: both appear in configuration and URLs. */
export const providerSlugSchema = z.string().regex(SLUG_PATTERN, {
  message: `provider slug ${SLUG_CONTRACT}`,
});

/** Schema for one provider operation. */
export const providerOperationSchema = z.enum(PROVIDER_OPERATIONS);

/** Schema for one provider status. */
export const providerStatusSchema = z.enum(PROVIDER_STATUSES);

/** Schema for one transport kind. */
export const transportKindSchema = z.enum(TRANSPORT_KINDS);

/** Schema for declared capabilities. */
export const providerCapabilitiesSchema = z.object({
  operations: z.array(providerOperationSchema).min(1),
  inputModalities: z.array(z.enum(MODALITIES)),
  outputModalities: z.array(z.enum(MODALITIES)),
  modelCapabilities: z.array(z.enum(MODEL_CAPABILITIES)),
});

/** A limit is either a positive integer or absent; `null` means the provider publishes none. */
const optionalLimitSchema = z.number().int().positive().nullable();

/** Schema for declared rate limits. */
export const providerRateLimitSchema = z.object({
  requestsPerMinute: optionalLimitSchema,
  tokensPerMinute: optionalLimitSchema,
  maxConcurrentRequests: optionalLimitSchema,
});

/** Schema for a complete, registered provider descriptor. */
export const providerDescriptorSchema = z.object({
  id: identifierSchemas.provider,
  slug: providerSlugSchema,
  displayName: nonEmptyStringSchema,
  transport: transportKindSchema,
  status: providerStatusSchema,
  capabilities: providerCapabilitiesSchema,
  rateLimit: providerRateLimitSchema,
  priority: z.number().int().min(0).max(1_000_000),
  latencyClass: z.enum(LATENCY_CLASSES),
  region: z.string().min(1).max(64).nullable(),
  policyId: identifierSchemas.policy.nullable(),
  budgetId: identifierSchemas.budget.nullable(),
  credentialsConfigured: z.boolean(),
  metadata: jsonObjectSchema,
  registeredAt: z.string().datetime(),
});

/**
 * Schema for a registration request.
 *
 * The identifier, the lifecycle status and the registration timestamp are assigned by the
 * registry: a provider starts `registered` and moves to `ready` when its adapter has been
 * verified, so a caller cannot register a provider as already ready.
 */
export const providerRegistrationInputSchema = z.object({
  id: identifierSchemas.provider.optional(),
  slug: providerSlugSchema,
  displayName: nonEmptyStringSchema,
  transport: transportKindSchema.optional(),
  capabilities: providerCapabilitiesSchema,
  rateLimit: providerRateLimitSchema.partial().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  latencyClass: z.enum(LATENCY_CLASSES).optional(),
  region: z.string().min(1).max(64).nullish(),
  policyId: identifierSchemas.policy.nullish(),
  budgetId: identifierSchemas.budget.nullish(),
  credentialsConfigured: z.boolean().optional(),
  metadata: jsonObjectSchema.optional(),
  registeredAt: z.string().datetime().optional(),
});

/** Schema for a provider reference. */
export const providerReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("id"), providerId: identifierSchemas.provider }),
  z.object({ kind: z.literal("slug"), slug: providerSlugSchema }),
]);

/** The descriptor contract. */
export const PROVIDER_DESCRIPTOR_CONTRACT = describeSchema(
  "ProviderDescriptor",
  providerDescriptorSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** The registration contract. */
export const PROVIDER_REGISTRATION_CONTRACT = describeSchema(
  "ProviderRegistration",
  providerRegistrationInputSchema,
  AI_CORE_CONTRACT_VERSION,
);

/** A registration request, as validated. */
export interface ProviderRegistrationInput {
  readonly id?: ProviderDescriptor["id"];
  readonly slug: string;
  readonly displayName: string;
  readonly transport?: TransportKind;
  readonly capabilities: {
    readonly operations: readonly ProviderOperation[];
    readonly inputModalities: readonly Modality[];
    readonly outputModalities: readonly Modality[];
    readonly modelCapabilities: readonly ModelCapability[];
  };
  readonly rateLimit?: {
    readonly requestsPerMinute?: number | null;
    readonly tokensPerMinute?: number | null;
    readonly maxConcurrentRequests?: number | null;
  };
  readonly priority?: number;
  readonly latencyClass?: LatencyClass;
  readonly region?: string | null;
  readonly policyId?: ProviderDescriptor["policyId"];
  readonly budgetId?: ProviderDescriptor["budgetId"];
  readonly credentialsConfigured?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly registeredAt?: string;
}

/** True when the value is a well-formed provider slug. */
export function isProviderSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}
