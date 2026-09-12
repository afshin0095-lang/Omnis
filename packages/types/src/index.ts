/**
 * `@omnis/types` — OMNIS domain-neutral primitives.
 *
 * This is the bottom of the dependency graph: it has **zero runtime
 * dependencies** and may only be imported, never import. The architecture tests
 * in `tests/architecture` enforce both properties.
 *
 * Re-exports are explicit rather than `export *` so the public surface is a
 * deliberate decision. In particular `unsafeBrand` is intentionally NOT exported
 * here: branding must be minted by a validating parser, never by a caller cast.
 */

// `BRAND` is an ambient `unique symbol` used purely as a type-level key. It has
// no runtime binding, so it is surfaced through the `BrandKey` type alias only —
// re-exporting it as a value would emit a broken ESM re-export.
export type { BrandKey, Branded, BrandLabel, Unbranded } from "./brand.js";

export { InvalidIdentifierError, InvalidValueError, OmnisTypeError } from "./errors.js";

export {
  isParseFailure,
  isParseSuccess,
  parseFailure,
  parseSuccess,
  unwrapParseResult,
} from "./parse.js";
export type { ParseFailure, ParseResult, ParseSuccess } from "./parse.js";

export {
  createMonotonicUlid,
  isUlid,
  ulid,
  ulidTimestamp,
  ULID_LENGTH,
  ULID_RANDOM_LENGTH,
  ULID_TIME_LENGTH,
} from "./ulid.js";
export type { EntropySource } from "./ulid.js";

export {
  asCausationId,
  createAgentId,
  createApprovalId,
  createCausationId,
  createChannelId,
  createCharacterId,
  createCommandId,
  createContentId,
  createContentRequestId,
  createCorrelationId,
  createEntityId,
  createEventId,
  createExecutionId,
  createIdentifier,
  createJobId,
  createOpportunityId,
  createPlatformAccountId,
  createSpanId,
  createTenantId,
  createTraceId,
  createUserId,
  createWorkspaceId,
  IDENTIFIER_KINDS,
  IDENTIFIER_LENGTH,
  IDENTIFIER_SEPARATOR,
  identifierKindOf,
  isIdentifierKind,
  isIdentifierOfKind,
  parseIdentifier,
  tryParseIdentifier,
} from "./identifiers.js";
export type {
  AgentId,
  ApprovalId,
  AnyIdentifier,
  CausationId,
  ChannelId,
  CharacterId,
  CommandId,
  ContentId,
  ContentRequestId,
  CorrelationId,
  EntityId,
  EventId,
  ExecutionId,
  IdentifierKind,
  IdentifierPrefix,
  IdentifierTypeMap,
  JobId,
  OpportunityId,
  PlatformAccountId,
  SpanId,
  TenantId,
  TraceId,
  UserId,
  WorkspaceId,
} from "./identifiers.js";

export {
  compareSemVer,
  isJsonValue,
  nowIso,
  parseEmailAddress,
  parseIsoDateTime,
  parseLanguageTag,
  parseNonEmptyString,
  parsePercentage,
  parseRatio,
  parseSemVer,
  parseTrimmedString,
  parseUri,
  semVerParts,
  toIso,
  tryParseEmailAddress,
  tryParseIsoDateTime,
  tryParseLanguageTag,
  tryParseNonEmptyString,
  tryParsePercentage,
  tryParseRatio,
  tryParseSemVer,
  tryParseTrimmedString,
  tryParseUri,
} from "./primitives.js";
export type {
  EmailAddress,
  IsoDateTimeString,
  JsonObject,
  JsonValue,
  LanguageTag,
  NonEmptyString,
  Percentage,
  Ratio,
  SemVer,
  SemVerParts,
  TrimmedString,
  Uri,
  UtcTimestamp,
} from "./primitives.js";

export {
  isLogFormat,
  isLogLevel,
  LOG_FORMATS,
  LOG_LEVELS,
  logLevelSeverity,
  normaliseLogLevel,
  shouldLog,
} from "./log.js";
export type { LogFormat, LogLevel } from "./log.js";

export {
  ENVIRONMENTS,
  isEnvironmentName,
  isNonProduction,
  isProduction,
  normaliseEnvironmentName,
} from "./environment.js";
export type { EnvironmentName } from "./environment.js";

export { isCommandName, parseCommandName, tryParseCommandName } from "./event-type.js";
export type { CommandName } from "./event-type.js";

export {
  EVENT_NAMESPACES,
  eventNamespaceOf,
  eventTypeSegments,
  isEventType,
  parseEventType,
  tryParseEventType,
} from "./event-type.js";
export type { EventNamespace, EventType } from "./event-type.js";

export {
  isSocialPlatform,
  normaliseSocialPlatform,
  PLANNED_SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_PLATFORMS,
} from "./platform.js";
export type { PlannedSocialPlatform, SocialPlatform } from "./platform.js";
