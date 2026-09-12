/**
 * Payload schemas for the event types whose contracts Sprint 0 agrees on.
 *
 * MODELLING RULES
 * ---------------
 * These rules are not stylistic; each one prevents a specific failure.
 *
 * 1. **No optional properties — use `T | null`.** An optional key disappears
 *    under `JSON.stringify`, so a consumer cannot distinguish "the producer
 *    omitted this" from "the producer asserted there is none". A `null` is an
 *    assertion and keeps the wire shape stable across versions. It is also what
 *    makes these payload types assignable to `JsonObject`.
 *
 * 2. **No nested serialized errors.** A failed-execution payload carries the
 *    error's *classification* (`errorCode`, `errorMessage`, `retryable`), not a
 *    whole `SerializedOmnisError`. Events state facts; a consumer that needs the
 *    full diagnostic follows `correlationId` to the execution record. This also
 *    keeps payloads flat enough to index in an analytics store.
 *
 * 3. **No duplicated envelope fields.** `actor`, `tenantId`, `correlationId` and
 *    `occurredAt` already live on the envelope. Repeating them in the payload
 *    creates two sources of truth that will disagree.
 *
 * 4. **No secrets, and no more personal data than the domain needs.** Comment
 *    text is inherently personal data and is retained only because Audience
 *    Intelligence cannot function without it; authors are referenced by an opaque
 *    platform handle, never by name, email or profile URL. See
 *    docs/01-architecture/SECURITY_BOUNDARIES.md.
 */

import { ERROR_CODE_VALUES } from "@omnis/errors";
import type { JsonObject } from "@omnis/types";
import {
  environmentSchema,
  identifierSchemas,
  isoDateTimeSchema,
  jsonObjectSchema,
  languageTagSchema,
  percentageSchema,
  ratioSchema,
  semVerSchema,
  serviceNameSchema,
  socialPlatformSchema,
  trimmedStringSchema,
  uriSchema,
  z,
} from "@omnis/validation";

// --- system.* --------------------------------------------------------------

/** `system.initialized` — a service finished booting. */
export const systemInitializedPayloadSchema = z.object({
  service: serviceNameSchema,
  version: semVerSchema,
  environment: environmentSchema,
});
export type SystemInitializedPayload = z.infer<typeof systemInitializedPayloadSchema>;

/** `system.configuration.loaded` — configuration was read and validated. */
export const configurationLoadedPayloadSchema = z.object({
  service: serviceNameSchema,
  environment: environmentSchema,
  /**
   * The *names* of the keys that were loaded.
   *
   * Values are never included, not even redacted ones: an event is broadcast and
   * persisted, and a redaction bug in one place would become a leak in every
   * subscriber. Key names alone are enough to diagnose a missing-variable
   * incident, which is the only reason this event exists.
   */
  keys: z.array(trimmedStringSchema).default([]),
  /** Whether any key fell back to its default rather than being supplied. */
  usedDefaults: z.boolean().default(false),
});
export type ConfigurationLoadedPayload = z.infer<typeof configurationLoadedPayloadSchema>;

// --- agent.* ---------------------------------------------------------------

/** The capability an agent execution was performing, e.g. `"script.draft"`. */
const capabilitySchema = trimmedStringSchema;

/** `agent.execution.started` */
export const agentExecutionStartedPayloadSchema = z.object({
  agentId: identifierSchemas.agent,
  capability: capabilitySchema,
  /**
   * Logical model reference, e.g. a model slug.
   *
   * Recorded for cost attribution and evaluation, never used to select a model:
   * selection belongs to the Model Router. `null` when the execution is not
   * model-backed (a deterministic tool run, for example).
   */
  model: trimmedStringSchema.nullable(),
});
export type AgentExecutionStartedPayload = z.infer<typeof agentExecutionStartedPayloadSchema>;

/** `agent.execution.completed` */
export const agentExecutionCompletedPayloadSchema = z.object({
  agentId: identifierSchemas.agent,
  capability: capabilitySchema,
  durationMs: z.number().int().nonnegative(),
  /** Total tokens consumed, or `null` when the execution was not model-backed. */
  tokensUsed: z.number().int().nonnegative().nullable(),
  /**
   * Monetary cost in USD, or `null` when it is not yet known.
   *
   * Nullable rather than defaulted to `0`, because `0` asserts "this was free"
   * while `null` asserts "we have not priced this yet". Budget enforcement
   * depends on that difference.
   */
  costUsd: z.number().nonnegative().nullable(),
});
export type AgentExecutionCompletedPayload = z.infer<typeof agentExecutionCompletedPayloadSchema>;

/** `agent.execution.failed` */
export const agentExecutionFailedPayloadSchema = z.object({
  agentId: identifierSchemas.agent,
  capability: capabilitySchema,
  durationMs: z.number().int().nonnegative(),
  /** Error classification, from the stable OMNIS code set. */
  errorCode: z.enum(ERROR_CODE_VALUES),
  /** Human-readable explanation, already redacted by the error hierarchy. */
  errorMessage: trimmedStringSchema,
  /** Whether an identical retry may succeed. Copied from the error. */
  retryable: z.boolean(),
});
export type AgentExecutionFailedPayload = z.infer<typeof agentExecutionFailedPayloadSchema>;

// --- character.* -----------------------------------------------------------

/** `character.created` — a persistent digital human came into existence. */
export const characterCreatedPayloadSchema = z.object({
  characterId: identifierSchemas.character,
  workspaceId: identifierSchemas.workspace.nullable(),
  displayName: trimmedStringSchema,
  /**
   * The character definition version this instance was created from.
   *
   * Characters are independently versionable, so the definition a character was
   * instantiated from must be recoverable — otherwise a behaviour change cannot
   * be attributed to either a definition edit or accumulated experience.
   */
  definitionVersion: semVerSchema,
});
export type CharacterCreatedPayload = z.infer<typeof characterCreatedPayloadSchema>;

/** What kind of thing a character experienced. */
export const EXPERIENCE_KINDS = [
  "content_performance",
  "audience_interaction",
  "reflection",
  "relationship",
  "external_event",
] as const;

/** One member of {@link EXPERIENCE_KINDS}. */
export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number];

/**
 * `character.experience.recorded` — the entry point of the evolution loop.
 *
 * ```text
 * Experience -> Observation -> Evaluation -> Reflection
 *          -> Learning -> Skill improvement -> Behaviour update
 *          -> Performance -> new Experience
 * ```
 *
 * Experience is recorded as structured state, never improvised per generation.
 * That is what allows a character to remain the same character across months of
 * content, and what makes evolution auditable rather than accidental.
 */
export const characterExperienceRecordedPayloadSchema = z.object({
  characterId: identifierSchemas.character,
  kind: z.enum(EXPERIENCE_KINDS),
  /** Short factual description of what happened, written for later reflection. */
  summary: trimmedStringSchema,
  occurredAt: isoDateTimeSchema,
  /** The content this experience relates to, when it relates to any. */
  contentId: identifierSchemas.content.nullable(),
  /**
   * Structured observations attached to the experience.
   *
   * Open-ended by design at Sprint 0: what is worth recording differs per
   * experience kind and is still being discovered. It is validated as JSON so it
   * can always be persisted and replayed, and individual kinds may layer a
   * stricter schema on top later without a breaking change.
   */
  observations: jsonObjectSchema.default({}),
});
export type CharacterExperienceRecordedPayload = z.infer<
  typeof characterExperienceRecordedPayloadSchema
>;

// --- audience.* ------------------------------------------------------------

/**
 * An opaque reference to the person who produced an audience signal.
 *
 * Deliberately **not** a name, email or profile URL. Audience Intelligence needs
 * to recognise a returning commenter and build a loyalty tier; it does not need
 * their identity, and holding less personal data is both a smaller breach surface
 * and a smaller compliance surface.
 */
const authorRefSchema = trimmedStringSchema;

/** Fields shared by every inbound audience signal. */
const audienceSignalBase = {
  platform: socialPlatformSchema,
  channelId: identifierSchemas.channel,
  /**
   * The platform's own identifier for the comment or message.
   *
   * Stored so ingestion is idempotent: the same webhook may be delivered more
   * than once, and deduplicating on this key is what prevents one comment from
   * inflating demand scoring.
   */
  externalId: trimmedStringSchema,
  /** The content the signal was left on, when it can be attributed. */
  contentId: identifierSchemas.content.nullable(),
  authorRef: authorRefSchema.nullable(),
  text: trimmedStringSchema,
  /** Detected language, or `null` when detection has not run or was inconclusive. */
  language: languageTagSchema.nullable(),
  /** When the audience member wrote it — not when OMNIS received it. */
  publishedAt: isoDateTimeSchema,
};

/** `audience.comment.received` */
export const audienceCommentReceivedPayloadSchema = z.object(audienceSignalBase);
export type AudienceCommentReceivedPayload = z.infer<typeof audienceCommentReceivedPayloadSchema>;

/** `audience.dm.received` */
export const audienceDmReceivedPayloadSchema = z.object({
  ...audienceSignalBase,
  /**
   * The platform's conversation identifier.
   *
   * A DM thread is a conversation, not a set of independent messages: without
   * this, intent detection sees disconnected fragments and loyalty scoring
   * cannot tell one long exchange from twenty brief ones.
   */
  conversationId: trimmedStringSchema,
});
export type AudienceDmReceivedPayload = z.infer<typeof audienceDmReceivedPayloadSchema>;

/** `audience.request.detected` — a content request was recognised in a signal. */
export const audienceRequestDetectedPayloadSchema = z.object({
  requestId: identifierSchemas.request,
  platform: socialPlatformSchema,
  /** The signal the request was extracted from. */
  sourceExternalId: trimmedStringSchema,
  /** Normalised description of what the audience asked for. */
  topic: trimmedStringSchema,
  /**
   * Detector confidence in `[0, 1]`.
   *
   * Recorded rather than thresholded at detection time: the confidence at which a
   * request is worth acting on is a *strategy* decision, and it will change as
   * the detector is evaluated. Baking a threshold in here would make that
   * decision invisible and unchangeable.
   */
  confidence: ratioSchema,
  detectedAt: isoDateTimeSchema,
});
export type AudienceRequestDetectedPayload = z.infer<typeof audienceRequestDetectedPayloadSchema>;

// --- content.* -------------------------------------------------------------

/** The shape of a piece of content. */
export const CONTENT_FORMATS = [
  "short_video",
  "long_video",
  "image_post",
  "text_post",
  "audio",
] as const;

/** One member of {@link CONTENT_FORMATS}. */
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/** `content.production.requested` */
export const contentProductionRequestedPayloadSchema = z.object({
  contentId: identifierSchemas.content,
  format: z.enum(CONTENT_FORMATS),
  /** The character presenting this content, when it is character-fronted. */
  characterId: identifierSchemas.character.nullable(),
  /** The scored opportunity that motivated this, when there was one. */
  opportunityId: identifierSchemas.opportunity.nullable(),
  /** Working title at request time; the final title is decided later. */
  workingTitle: trimmedStringSchema.nullable(),
});
export type ContentProductionRequestedPayload = z.infer<
  typeof contentProductionRequestedPayloadSchema
>;

/** `content.production.started` */
export const contentProductionStartedPayloadSchema = z.object({
  contentId: identifierSchemas.content,
  startedAt: isoDateTimeSchema,
  /** Version of the pipeline definition being run, so results are attributable. */
  pipelineVersion: semVerSchema,
});
export type ContentProductionStartedPayload = z.infer<typeof contentProductionStartedPayloadSchema>;

/** `content.production.completed` */
export const contentProductionCompletedPayloadSchema = z.object({
  contentId: identifierSchemas.content,
  completedAt: isoDateTimeSchema,
  durationMs: z.number().int().nonnegative(),
  /**
   * Location of the produced master asset.
   *
   * `null` when production completed but produced no single master (a
   * multi-asset post, for example), in which case the assets are referenced from
   * the content record rather than the event.
   */
  assetUri: uriSchema.nullable(),
  /**
   * Quality-assurance score in `[0, 1]`, or `null` when QA has not scored it.
   *
   * Nullable because a completed production is not necessarily an approved one:
   * the approval gate is a separate decision and must not be inferred from the
   * presence of a score.
   */
  qualityScore: ratioSchema.nullable(),
});
export type ContentProductionCompletedPayload = z.infer<
  typeof contentProductionCompletedPayloadSchema
>;

// --- publishing.* ----------------------------------------------------------

/** Fields shared by publishing job events. */
const publishingJobBase = {
  jobId: identifierSchemas.job,
  contentId: identifierSchemas.content,
  channelId: identifierSchemas.channel,
  platform: socialPlatformSchema,
};

/** `publishing.job.created` */
export const publishingJobCreatedPayloadSchema = z.object({
  ...publishingJobBase,
  /** `null` means publish as soon as the queue reaches it. */
  scheduledFor: isoDateTimeSchema.nullable(),
  /**
   * Whether a human must approve before this job may run.
   *
   * Decided by the policy engine at job creation, not at execution time, so the
   * requirement is visible in the queue and cannot be quietly skipped by a
   * retry path that bypasses the original decision.
   */
  approvalRequired: z.boolean(),
});
export type PublishingJobCreatedPayload = z.infer<typeof publishingJobCreatedPayloadSchema>;

/**
 * `publishing.job.completed`
 *
 * Emitted **only** when the platform has confirmed the publication. A job that
 * was submitted but not confirmed is not complete; claiming otherwise would be
 * the single most damaging kind of false signal in the platform, because
 * everything downstream — analytics, audience feedback, strategy learning —
 * would be measuring content that does not exist.
 */
export const publishingJobCompletedPayloadSchema = z.object({
  ...publishingJobBase,
  /** The platform's own identifier for the published item. */
  externalPublicationId: trimmedStringSchema,
  /** Canonical public URL, when the platform supplied one. */
  publicationUrl: uriSchema.nullable(),
  publishedAt: isoDateTimeSchema,
});
export type PublishingJobCompletedPayload = z.infer<typeof publishingJobCompletedPayloadSchema>;

// --- analytics.* -----------------------------------------------------------

/**
 * The measurement set recorded for a piece of content over a window.
 *
 * Every field is nullable where a platform may not supply it. A missing metric
 * is recorded as `null`, never as `0`: `0` views and "the platform did not
 * report views" lead to completely different strategic conclusions, and
 * conflating them would teach the learning loop something false.
 */
export const performanceMetricsSchema = z.object({
  views: z.number().int().nonnegative().nullable(),
  likes: z.number().int().nonnegative().nullable(),
  comments: z.number().int().nonnegative().nullable(),
  shares: z.number().int().nonnegative().nullable(),
  saves: z.number().int().nonnegative().nullable(),
  watchTimeSeconds: z.number().nonnegative().nullable(),
  averageViewDurationSeconds: z.number().nonnegative().nullable(),
  clickThroughRate: percentageSchema.nullable(),
  retentionRate: ratioSchema.nullable(),
  subscribersGained: z.number().int().nullable(),
  revenueUsd: z.number().nonnegative().nullable(),
});
export type PerformanceMetrics = z.infer<typeof performanceMetricsSchema>;

/** `analytics.performance.recorded` */
export const analyticsPerformanceRecordedPayloadSchema = z.object({
  contentId: identifierSchemas.content,
  channelId: identifierSchemas.channel,
  platform: socialPlatformSchema,
  measuredAt: isoDateTimeSchema,
  /**
   * Length of the measurement window in hours.
   *
   * Recorded on every sample so that metrics taken at different maturities are
   * never compared as if they were equivalent. A 24-hour view count and a
   * 30-day view count are different measurements, and forgetting which is which
   * is how a growth dashboard starts lying.
   */
  windowHours: z.number().int().positive(),
  metrics: performanceMetricsSchema,
});
export type AnalyticsPerformanceRecordedPayload = z.infer<
  typeof analyticsPerformanceRecordedPayloadSchema
>;

// ---------------------------------------------------------------------------
// Compile-time contract assertion
// ---------------------------------------------------------------------------

/**
 * Fails to compile unless `TPayload` is assignable to {@link JsonObject}.
 *
 * Every event payload must be JSON-representable, because payloads travel through
 * serializers, queues and third-party observability backends. The failure mode
 * this guards against is subtle and expensive: an optional property (`foo?: T`)
 * widens to `T | undefined`, which is *not* JSON-representable, and the payload
 * then silently loses the key under `JSON.stringify` — so consumers see "absent"
 * where the producer meant "none". Rule 1 at the top of this file only holds if
 * something enforces it, and this is that something.
 */
type AssertJsonObject<TPayload extends JsonObject> = TPayload;

/**
 * The assertion itself.
 *
 * Exported so that `noUnusedLocals` does not flag it, and so the guarantee is
 * visible in the package's public type surface. Adding a payload schema without
 * adding it here is the only way to bypass the check, which a review of this
 * list makes obvious.
 */
export type PayloadJsonSafetyAssertion = [
  AssertJsonObject<SystemInitializedPayload>,
  AssertJsonObject<ConfigurationLoadedPayload>,
  AssertJsonObject<AgentExecutionStartedPayload>,
  AssertJsonObject<AgentExecutionCompletedPayload>,
  AssertJsonObject<AgentExecutionFailedPayload>,
  AssertJsonObject<CharacterCreatedPayload>,
  AssertJsonObject<CharacterExperienceRecordedPayload>,
  AssertJsonObject<AudienceCommentReceivedPayload>,
  AssertJsonObject<AudienceDmReceivedPayload>,
  AssertJsonObject<AudienceRequestDetectedPayload>,
  AssertJsonObject<ContentProductionRequestedPayload>,
  AssertJsonObject<ContentProductionStartedPayload>,
  AssertJsonObject<ContentProductionCompletedPayload>,
  AssertJsonObject<PublishingJobCreatedPayload>,
  AssertJsonObject<PublishingJobCompletedPayload>,
  AssertJsonObject<AnalyticsPerformanceRecordedPayload>,
];
