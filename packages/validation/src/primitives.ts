/**
 * Zod schemas for the branded primitives declared in `@omnis/types`.
 *
 * THE KEY DESIGN DECISION
 * -----------------------
 * Each schema delegates its validity check to the corresponding `@omnis/types`
 * parser (`tryParseIdentifier`, `tryParseIsoDateTime`, ...). It does **not**
 * reimplement the rule as a regular expression or a Zod combinator.
 *
 * A validation rule written twice — once in the parser, once in a schema — is a
 * rule that will eventually disagree with itself. Identifier formats and
 * timestamp handling are exactly the kind of detail that drifts when someone
 * tightens one copy and forgets the other. Delegating means there is one
 * implementation of "what is a valid CharacterId" and the schema is only a
 * runtime gate in front of it.
 *
 * Most schemas are built with `z.custom` rather than `z.string().transform()` because
 * it keeps the schema's input type `unknown`, which is what makes them composable
 * inside `z.object({...})` while still satisfying {@link OmnisSchema}.
 *
 * The two exceptions — {@link environmentSchema} and {@link logLevelSchema} — accept
 * conventional aliases, and an alias that is merely *permitted* rather than resolved
 * would put a value into a branded type that does not exist (`"verbose"` as a
 * `LogLevel`). Those two therefore start from `z.unknown()` and transform, which keeps
 * the same `unknown` input while producing the canonical output.
 *
 * These schemas are the only place outside `@omnis/types` that mints a branded
 * value, and they only ever mint one after the parser has accepted it.
 */

import { z } from "zod";
import {
  ENVIRONMENTS,
  IDENTIFIER_KINDS,
  isIdentifierOfKind,
  LOG_FORMATS,
  LOG_LEVELS,
  normaliseEnvironmentName,
  normaliseLogLevel,
  SOCIAL_PLATFORMS,
  tryParseCommandName,
  tryParseEmailAddress,
  tryParseEventType,
  tryParseIdentifier,
  tryParseIsoDateTime,
  tryParseLanguageTag,
  tryParseNonEmptyString,
  tryParsePercentage,
  tryParseRatio,
  tryParseSemVer,
  tryParseTrimmedString,
  tryParseUri,
  type CausationId,
  type CommandName,
  type EmailAddress,
  type EnvironmentName,
  type EventType,
  type IdentifierKind,
  type IdentifierTypeMap,
  type IsoDateTimeString,
  type JsonObject,
  type JsonValue,
  type LanguageTag,
  type LogFormat,
  type LogLevel,
  type NonEmptyString,
  type Percentage,
  type SocialPlatform,
  type Ratio,
  type SemVer,
  type TrimmedString,
  type Uri,
} from "@omnis/types";

/**
 * Builds a schema for one identifier kind.
 *
 * @example
 * ```ts
 * const schema = z.object({ tenantId: identifierSchema("tenant") });
 * ```
 */
export function identifierSchema<KKind extends IdentifierKind>(
  kind: KKind,
): z.ZodType<IdentifierTypeMap[KKind]> {
  return z.custom<IdentifierTypeMap[KKind]>((value) => tryParseIdentifier(kind, value).ok, {
    error: `Expected a ${kind} identifier of the form ${IDENTIFIER_KINDS[kind]}_<ULID>`,
  });
}

/**
 * A schema for every identifier kind, keyed by kind name.
 *
 * Provided so contracts can write `identifierSchemas.character` instead of
 * calling the factory repeatedly; the object is built once at module load.
 */
export const identifierSchemas = {
  entity: identifierSchema("entity"),
  tenant: identifierSchema("tenant"),
  user: identifierSchema("user"),
  workspace: identifierSchema("workspace"),
  character: identifierSchema("character"),
  agent: identifierSchema("agent"),
  approval: identifierSchema("approval"),
  content: identifierSchema("content"),
  channel: identifierSchema("channel"),
  platformAccount: identifierSchema("platformAccount"),
  execution: identifierSchema("execution"),
  command: identifierSchema("command"),
  event: identifierSchema("event"),
  correlation: identifierSchema("correlation"),
  causation: identifierSchema("causation"),
  job: identifierSchema("job"),
  opportunity: identifierSchema("opportunity"),
  request: identifierSchema("request"),
  trace: identifierSchema("trace"),
  span: identifierSchema("span"),
  model: identifierSchema("model"),
  provider: identifierSchema("provider"),
  tool: identifierSchema("tool"),
  policy: identifierSchema("policy"),
  budget: identifierSchema("budget"),
  reservation: identifierSchema("reservation"),
  evaluation: identifierSchema("evaluation"),
  plan: identifierSchema("plan"),
} satisfies { [KKind in IdentifierKind]: z.ZodType<IdentifierTypeMap[KKind]> };

/**
 * A causation reference: the identifier of the command or event that directly caused
 * this one.
 *
 * Accepts the `cau_`, `evt_` and `cmd_` prefixes, because a causation reference *is*
 * the causing message's identifier — `asCausationId` in `@omnis/types` changes its role,
 * not its value. A schema that demanded `cau_` would reject every reference produced by
 * `createCausedEvent`, which is to say every real one, and the causal chain would fail
 * to cross a wire even though it was perfectly formed in memory.
 *
 * Keeping the value unchanged is what makes the audit trail navigable: a consumer
 * holding a `causationId` can read the causing event directly, with no prefix surgery
 * and no second lookup table.
 */
export const causationIdSchema: z.ZodType<CausationId> = z.custom<CausationId>(
  (value) =>
    isIdentifierOfKind("causation", value) ||
    isIdentifierOfKind("event", value) ||
    isIdentifierOfKind("command", value),
  { error: "Expected the identifier of the causing event or command (evt_, cmd_ or cau_)" },
);

/** An ISO 8601 UTC timestamp. */
export const isoDateTimeSchema: z.ZodType<IsoDateTimeString> = z.custom<IsoDateTimeString>(
  (value) => tryParseIsoDateTime(value).ok,
  { error: "Expected an ISO 8601 UTC timestamp such as 2026-09-11T12:00:00.000Z" },
);

/** Semantic alias used where a value is specifically an event or log instant. */
export const utcTimestampSchema = isoDateTimeSchema;

/** An absolute URI. */
export const uriSchema: z.ZodType<Uri> = z.custom<Uri>((value) => tryParseUri(value).ok, {
  error: "Expected an absolute URI",
});

/**
 * An email address.
 *
 * Validation failures deliberately do not echo the rejected value: an email
 * address is personal data and must not be written into a log line or an API
 * error response.
 */
export const emailAddressSchema: z.ZodType<EmailAddress> = z.custom<EmailAddress>(
  (value) => tryParseEmailAddress(value).ok,
  { error: "Expected a valid email address" },
);

/** A number in `[0, 100]`. */
export const percentageSchema: z.ZodType<Percentage> = z.custom<Percentage>(
  (value) => tryParsePercentage(value).ok,
  { error: "Expected a finite number between 0 and 100" },
);

/** A number in `[0, 1]`. */
export const ratioSchema: z.ZodType<Ratio> = z.custom<Ratio>((value) => tryParseRatio(value).ok, {
  error: "Expected a finite number between 0 and 1",
});

/** A semantic version string. */
export const semVerSchema: z.ZodType<SemVer> = z.custom<SemVer>(
  (value) => tryParseSemVer(value).ok,
  { error: "Expected MAJOR.MINOR.PATCH with an optional pre-release tag" },
);

/**
 * A dotted event type name, e.g. `character.created`.
 *
 * The first segment determines which domain owns the event; see
 * `EVENT_NAMESPACES` in `@omnis/types`.
 */
export const eventTypeSchema: z.ZodType<EventType> = z.custom<EventType>(
  (value) => tryParseEventType(value).ok,
  {
    error:
      "Expected a lowercase dotted event type of at least two segments, e.g. character.created",
  },
);

/** A dotted imperative command name, e.g. `content.production.start`. */
export const commandNameSchema: z.ZodType<CommandName> = z.custom<CommandName>(
  (value) => tryParseCommandName(value).ok,
  {
    error:
      "Expected a lowercase dotted command name of at least two segments, e.g. content.production.start",
  },
);

/**
 * One of the deployment environments OMNIS recognises.
 *
 * Accepts the conventional abbreviations on input (`prod`, `dev`, `ci`, `uat`, ...) and
 * always yields the canonical {@link EnvironmentName}. Normalising here rather than
 * rejecting matters because `resolveEnvironment` in `@omnis/config` already accepts the
 * abbreviations: a schema that refused them would make `OMNIS_ENV=prod` resolve
 * successfully and then fail validation one line later, which reads as a bug in the
 * deployment rather than as a rejected value.
 *
 * The output stays canonical, so anything downstream — an event payload, a log line, a
 * trace attribute — carries exactly one spelling of each environment.
 */
export const environmentSchema: z.ZodType<EnvironmentName, unknown> = z
  .unknown()
  .transform((value) => normaliseEnvironmentName(value))
  .pipe(
    z.enum(ENVIRONMENTS, {
      error: `Expected one of: ${ENVIRONMENTS.join(", ")} (or a conventional abbreviation such as dev, ci, prod)`,
    }),
  );

/**
 * A log severity, accepting the conventional aliases.
 *
 * `verbose`/`trace` map to `debug` and `fatal`/`critical` map to `error`, because those
 * are the spellings operators and logging documentation actually use, and rejecting them
 * would mean a deployment failing over a synonym.
 *
 * The mapping is performed, not merely permitted. A predicate-only schema accepts
 * `"verbose"` and then hands back the string `"verbose"` branded as a `LogLevel`, which
 * is a value that does not exist: `logLevelSeverity` has no entry for it, every
 * comparison against a threshold is false, and the process goes silent. Accepting the
 * alias is only safe if the alias is resolved on the way through.
 */
export const logLevelSchema: z.ZodType<LogLevel, unknown> = z
  .unknown()
  .transform((value) => normaliseLogLevel(value))
  .pipe(
    z.enum(LOG_LEVELS, {
      error: `Expected one of: ${LOG_LEVELS.join(", ")} (or a conventional alias such as verbose or fatal)`,
    }),
  );

/** A log output format. The enum is the whole rule; there are no aliases to accept. */
export const logFormatSchema: z.ZodType<LogFormat> = z.enum(LOG_FORMATS, {
  error: `Expected one of: ${LOG_FORMATS.join(", ")}`,
});

/** A BCP 47 language tag. */
export const languageTagSchema: z.ZodType<LanguageTag> = z.custom<LanguageTag>(
  (value) => tryParseLanguageTag(value).ok,
  { error: "Expected a BCP 47 language tag such as en, en-GB or fa-IR" },
);

/** A string with no leading or trailing whitespace and at least one character. */
export const trimmedStringSchema: z.ZodType<TrimmedString> = z.custom<TrimmedString>(
  (value) => tryParseTrimmedString(value).ok,
  { error: "Expected a non-empty string with no leading or trailing whitespace" },
);

/** A string containing at least one non-whitespace character. */
export const nonEmptyStringSchema: z.ZodType<NonEmptyString> = z.custom<NonEmptyString>(
  (value) => tryParseNonEmptyString(value).ok,
  { error: "Expected a non-empty string" },
);

/**
 * A logical OMNIS service name, e.g. `content-factory` or
 * `audience-intelligence.ingestion`.
 *
 * Lowercase, dot-separated, URL- and log-safe. Enforced here rather than in
 * `@omnis/contracts` because it is a *format* rule about a primitive string, not
 * a cross-domain agreement, and because configuration needs it before any
 * contract is involved.
 */
export const serviceNameSchema: z.ZodType<TrimmedString> = trimmedStringSchema.refine(
  (value) => SERVICE_NAME_PATTERN.test(value),
  { error: "Expected a lowercase dot-separated service name, e.g. content-factory" },
);

const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

/**
 * One of the platforms OMNIS publishes to and ingests signals from.
 *
 * Strict on the canonical identifier: the enum is the whole rule. Loose inbound
 * spellings (`"Twitter"`, `"YouTube.com"`) are resolved by `normaliseSocialPlatform` at
 * the ingestion boundary, before a value reaches a contract — normalising inside a
 * contract schema would let two spellings of one platform into stored data.
 */
export const socialPlatformSchema: z.ZodType<SocialPlatform> = z.enum(SOCIAL_PLATFORMS, {
  error: "Expected a supported social platform",
});

/**
 * Any JSON-serializable value.
 *
 * Used for event payloads, log context and telemetry attributes. Rejecting
 * `undefined`, `NaN`, functions, symbols and `BigInt` here is what prevents the
 * failure mode where an event is accepted locally and then silently dropped by a
 * JSON-based transport.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** A JSON object (never an array or a scalar). */
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

/**
 * A record whose values are JSON-serializable, keyed by an arbitrary string.
 *
 * Distinct from {@link jsonObjectSchema} only in intent: this is the shape used
 * for open-ended metadata bags (error metadata, span attributes, log context),
 * where an empty object is valid and unknown keys are expected.
 */
export const attributesSchema = jsonObjectSchema;
