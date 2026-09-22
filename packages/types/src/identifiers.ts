/**
 * The OMNIS identifier family.
 *
 * WHY
 * ---
 * OMNIS is a distributed, multi-tenant system in which a single request fans out
 * across AI execution, character state, audience ingestion, production,
 * publishing and analytics. Every record, event, log line and trace must be
 * attributable to a specific tenant, actor, character, agent, execution and
 * correlation chain. Making those references distinct *types* — not distinct
 * string conventions — is what stops a `CharacterId` from being written into a
 * `TenantId` column six sprints from now.
 *
 * FORMAT
 * ------
 * ```text
 * <prefix>_<ULID>        e.g. chr_01J9ZX7Q4M2V8K5N3R6T0WYB1C
 * ```
 * - `prefix` is a fixed 3-character kind tag, so an identifier is
 *   self-describing in a log line or a support ticket without a schema lookup.
 * - The body is a 26-character Crockford base32 ULID: time-ordered, CSPRNG
 *   backed, coordination-free, and safe in URLs, filenames and JSON.
 *
 * INVARIANTS
 * ----------
 * - An identifier is immutable and globally unique for the lifetime of the
 *   system. It is never reused, never re-derived, never sequential.
 * - Identifiers are opaque: no domain meaning may be encoded in, or read out of,
 *   anything except the kind prefix.
 * - Identifiers are always serializable as plain strings; the brand is erased.
 * - `correlationId` and `causationId` use the same encoding as other
 *   identifiers so a single parse path serves all of them.
 *
 * EXTENDING
 * ---------
 * Adding a kind is a three-line change: add an entry to {@link IDENTIFIER_KINDS}
 * and to {@link IdentifierTypeMap}, then export the branded alias. Prefixes must
 * be unique and must never be recycled — existing identifiers embed them.
 */

import { unsafeBrand } from "./brand.js";
import type { Branded } from "./brand.js";
import { InvalidIdentifierError } from "./errors.js";
import { parseFailure, parseSuccess, type ParseResult } from "./parse.js";
import { createMonotonicUlid, isUlid, ULID_LENGTH } from "./ulid.js";

/**
 * Canonical identifier kinds and their wire prefixes.
 *
 * This object is the single source of truth for the prefix namespace; the
 * branded aliases and the runtime parser are both derived from it.
 */
export const IDENTIFIER_KINDS = {
  /** Root of the identity graph; the ancestor of every other identifier. */
  entity: "ent",
  /** Owning organisation or account boundary for multi-tenancy. */
  tenant: "ten",
  /** A human principal able to authenticate and approve actions. */
  user: "usr",
  /** A working area inside a tenant grouping characters, channels and content. */
  workspace: "wks",
  /** A persistent digital human owned by Character OS. */
  character: "chr",
  /** A registered autonomous agent owned by the Agent Runtime. */
  agent: "agt",
  /** A unit of content moving through the Content Factory. */
  content: "cnt",
  /** A publishable destination (a YouTube channel, an Instagram profile, ...). */
  channel: "chn",
  /** An authenticated connection to an external social platform. */
  platformAccount: "pac",
  /** One bounded run of an agent, tool or production pipeline. */
  execution: "exe",
  /** A request to perform a state-changing operation. */
  command: "cmd",
  /** A single event in an event stream. */
  event: "evt",
  /** Ties every record produced by one end-to-end business operation together. */
  correlation: "cor",
  /** Identifies the specific command or event that directly caused this one. */
  causation: "cau",
  /** A queued unit of work, e.g. a publishing job. */
  job: "job",
  /** A pending human approval gate on a high-impact autonomous action. */
  approval: "apr",
  /** A scored content opportunity raised by Audience Intelligence or Strategy. */
  opportunity: "opp",
  /** An audience-expressed content request before it is clustered. */
  request: "req",
  /** A distributed trace, compatible with W3C trace context propagation. */
  trace: "trc",
  /** A single span within a trace. */
  span: "spn",
  /** A registered model offering, addressed through the Model Registry. */
  model: "mdl",
  /** A registered provider endpoint, addressed through the Provider Registry. */
  provider: "prv",
  /** A registered tool an agent may invoke through the Tool Runtime. */
  tool: "tol",
  /** A policy set evaluated before any privileged execution. */
  policy: "pol",
  /** A budget envelope bounding tokens, requests, time, money or tool calls. */
  budget: "bud",
  /** A hold against a budget, committed or released when the work finishes. */
  reservation: "rsv",
  /** One evaluation run over an execution result. */
  evaluation: "evl",
  /** An execution plan produced for one execution. */
  plan: "pln",
} as const;

/** Union of identifier kind names, e.g. `"character" | "tenant" | ...`. */
export type IdentifierKind = keyof typeof IDENTIFIER_KINDS;

/** Union of the 3-character wire prefixes, e.g. `"chr" | "ten" | ...`. */
export type IdentifierPrefix = (typeof IDENTIFIER_KINDS)[IdentifierKind];

// --- Branded aliases -------------------------------------------------------

/** Generic reference to any persisted entity. */
export type EntityId = Branded<string, "EntityId">;
/** Tenant boundary identifier; present on every event and every log line. */
export type TenantId = Branded<string, "TenantId">;
/** Human user identifier. */
export type UserId = Branded<string, "UserId">;
/** Workspace identifier within a tenant. */
export type WorkspaceId = Branded<string, "WorkspaceId">;
/** Digital human identifier owned by Character OS. */
export type CharacterId = Branded<string, "CharacterId">;
/** Agent identifier owned by the Agent Runtime. */
export type AgentId = Branded<string, "AgentId">;
/** Content identifier owned by the Content Factory. */
export type ContentId = Branded<string, "ContentId">;
/** Channel identifier owned by Publishing. */
export type ChannelId = Branded<string, "ChannelId">;
/** Platform account identifier owned by Publishing / Security. */
export type PlatformAccountId = Branded<string, "PlatformAccountId">;
/** Execution identifier owned by AI Core. */
export type ExecutionId = Branded<string, "ExecutionId">;
/** Command identifier, unique per issued command. */
export type CommandId = Branded<string, "CommandId">;
/** Event identifier owned by the event infrastructure. */
export type EventId = Branded<string, "EventId">;
/** Correlation identifier propagated across an entire business operation. */
export type CorrelationId = Branded<string, "CorrelationId">;
/** Causation identifier linking one event to its direct cause. */
export type CausationId = Branded<string, "CausationId">;
/** Background job identifier. */
export type JobId = Branded<string, "JobId">;
/** Pending human-approval gate identifier. */
export type ApprovalId = Branded<string, "ApprovalId">;
/** Content opportunity identifier owned by Content Strategy. */
export type OpportunityId = Branded<string, "OpportunityId">;
/** Audience content request identifier owned by Audience Intelligence. */
export type ContentRequestId = Branded<string, "ContentRequestId">;
/** Distributed trace identifier. */
export type TraceId = Branded<string, "TraceId">;
/** Distributed span identifier. */
export type SpanId = Branded<string, "SpanId">;
/** Registered model offering identifier owned by the Model Registry. */
export type ModelId = Branded<string, "ModelId">;
/** Registered provider endpoint identifier owned by the Provider Registry. */
export type ProviderId = Branded<string, "ProviderId">;
/** Registered tool identifier owned by the Tool Runtime. */
export type ToolId = Branded<string, "ToolId">;
/** Policy set identifier owned by the Policy Engine. */
export type PolicyId = Branded<string, "PolicyId">;
/** Budget envelope identifier owned by the Budget Engine. */
export type BudgetId = Branded<string, "BudgetId">;
/** Budget reservation identifier owned by the Budget Engine. */
export type ReservationId = Branded<string, "ReservationId">;
/** Evaluation run identifier owned by AI Evaluation. */
export type EvaluationId = Branded<string, "EvaluationId">;
/** Execution plan identifier owned by the Execution Kernel. */
export type PlanId = Branded<string, "PlanId">;

/** The single most specific identifier type; used for polymorphic references. */
export type AnyIdentifier =
  | EntityId
  | TenantId
  | UserId
  | WorkspaceId
  | CharacterId
  | AgentId
  | ContentId
  | ChannelId
  | PlatformAccountId
  | ExecutionId
  | CommandId
  | EventId
  | CorrelationId
  | CausationId
  | JobId
  | ApprovalId
  | OpportunityId
  | ContentRequestId
  | TraceId
  | SpanId
  | ModelId
  | ProviderId
  | ToolId
  | PolicyId
  | BudgetId
  | ReservationId
  | EvaluationId
  | PlanId;

/** Maps a kind name to its branded identifier type. */
export interface IdentifierTypeMap {
  entity: EntityId;
  tenant: TenantId;
  user: UserId;
  workspace: WorkspaceId;
  character: CharacterId;
  agent: AgentId;
  content: ContentId;
  channel: ChannelId;
  platformAccount: PlatformAccountId;
  execution: ExecutionId;
  command: CommandId;
  event: EventId;
  correlation: CorrelationId;
  causation: CausationId;
  job: JobId;
  approval: ApprovalId;
  opportunity: OpportunityId;
  request: ContentRequestId;
  trace: TraceId;
  span: SpanId;
  model: ModelId;
  provider: ProviderId;
  tool: ToolId;
  policy: PolicyId;
  budget: BudgetId;
  reservation: ReservationId;
  evaluation: EvaluationId;
  plan: PlanId;
}

/** Prefix → kind reverse index, built once at module load. */
const KIND_BY_PREFIX: ReadonlyMap<string, IdentifierKind> = new Map(
  (Object.keys(IDENTIFIER_KINDS) as IdentifierKind[]).map((kind) => [IDENTIFIER_KINDS[kind], kind]),
);

/** The separator between the kind prefix and the ULID body. */
export const IDENTIFIER_SEPARATOR = "_";

/** Total length of a well-formed identifier: prefix + separator + ULID. */
export const IDENTIFIER_LENGTH = 3 + IDENTIFIER_SEPARATOR.length + ULID_LENGTH;

/** Type guard for identifier kind names. */
export function isIdentifierKind(value: string): value is IdentifierKind {
  return Object.hasOwn(IDENTIFIER_KINDS, value);
}

/**
 * Returns the kind an identifier string belongs to, or `null` if the prefix is
 * unknown or the body is malformed.
 *
 * Useful for routing and for validating that an inbound reference matches the
 * slot it was placed in.
 */
export function identifierKindOf(value: string): IdentifierKind | null {
  const separatorIndex = value.indexOf(IDENTIFIER_SEPARATOR);
  if (separatorIndex !== 3) {
    return null;
  }
  const prefix = value.slice(0, separatorIndex);
  const body = value.slice(separatorIndex + 1);
  if (!isUlid(body)) {
    return null;
  }
  return KIND_BY_PREFIX.get(prefix) ?? null;
}

/** Non-throwing validation of an identifier against a specific kind. */
export function tryParseIdentifier<KKind extends IdentifierKind>(
  kind: KKind,
  value: unknown,
): ParseResult<IdentifierTypeMap[KKind]> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  if (value.length !== IDENTIFIER_LENGTH) {
    return parseFailure(`expected ${IDENTIFIER_LENGTH} characters, received ${value.length}`);
  }
  const separatorIndex = value.indexOf(IDENTIFIER_SEPARATOR);
  if (separatorIndex !== 3) {
    return parseFailure("missing prefix separator at position 3");
  }

  const prefix = value.slice(0, separatorIndex);
  const expectedPrefix = IDENTIFIER_KINDS[kind];
  if (prefix !== expectedPrefix) {
    return parseFailure(`expected prefix "${expectedPrefix}", received "${prefix}"`);
  }
  if (!isUlid(value.slice(separatorIndex + 1))) {
    return parseFailure("body is not a valid Crockford base32 ULID");
  }

  return parseSuccess(unsafeBrand<IdentifierTypeMap[KKind]>(value));
}

/**
 * Validates an identifier, throwing {@link InvalidIdentifierError} on failure.
 *
 * Use at trust boundaries (HTTP handlers, event consumers, repository adapters)
 * where a malformed identifier means the contract has already been broken.
 */
export function parseIdentifier<KKind extends IdentifierKind>(
  kind: KKind,
  value: unknown,
): IdentifierTypeMap[KKind] {
  const result = tryParseIdentifier(kind, value);
  if (!result.ok) {
    throw new InvalidIdentifierError(
      kind,
      typeof value === "string" ? value : String(value),
      result.reason,
    );
  }
  return result.value;
}

/** Structural check: does `value` belong to `kind`? */
export function isIdentifierOfKind<KKind extends IdentifierKind>(
  kind: KKind,
  value: unknown,
): value is IdentifierTypeMap[KKind] {
  return tryParseIdentifier(kind, value).ok;
}

/**
 * Mints a new identifier of the given kind.
 *
 * Generators are created lazily per kind and are monotonic, so identifiers
 * produced inside the same millisecond remain strictly time-ordered — a property
 * the event store and every audit trail rely on.
 */
export function createIdentifier<KKind extends IdentifierKind>(
  kind: KKind,
): IdentifierTypeMap[KKind] {
  const generate = generatorFor(kind);
  return unsafeBrand<IdentifierTypeMap[KKind]>(
    `${IDENTIFIER_KINDS[kind]}${IDENTIFIER_SEPARATOR}${generate()}`,
  );
}

const generators = new Map<IdentifierKind, () => string>();

/**
 * Returns the shared monotonic generator for a kind.
 *
 * One generator per kind keeps per-stream ordering strong while avoiding the
 * cost of re-seeding entropy on every call.
 */
function generatorFor(kind: IdentifierKind): () => string {
  const existing = generators.get(kind);
  if (existing !== undefined) {
    return existing;
  }
  const created = createMonotonicUlid();
  generators.set(kind, created);
  return created;
}

/**
 * Reinterprets an event or command identifier as the causation reference it is
 * acting as.
 *
 * WHY: `causationId` does not identify a new thing — it identifies the message
 * that directly caused this one, which is always an existing event or command.
 * The value therefore *is* that message's identifier; only the role differs.
 * Modelling the role as a distinct brand keeps call sites honest ("this slot
 * holds a cause, not just any id") without inventing a second identifier for the
 * same object.
 *
 * This is the single sanctioned place where one identifier brand is read as
 * another. It is lossless because both brands share one encoding, and it is
 * isolated here rather than being an inline `as unknown as` at each call site so
 * that the exception is visible, reviewable and greppable.
 */
export function asCausationId(source: EventId | CommandId): CausationId {
  return unsafeBrand<CausationId>(source);
}

/** Convenience constructors — the call sites most code should use. */
export const createEntityId = (): EntityId => createIdentifier("entity");
export const createTenantId = (): TenantId => createIdentifier("tenant");
export const createUserId = (): UserId => createIdentifier("user");
export const createWorkspaceId = (): WorkspaceId => createIdentifier("workspace");
export const createCharacterId = (): CharacterId => createIdentifier("character");
export const createAgentId = (): AgentId => createIdentifier("agent");
export const createContentId = (): ContentId => createIdentifier("content");
export const createChannelId = (): ChannelId => createIdentifier("channel");
export const createPlatformAccountId = (): PlatformAccountId => createIdentifier("platformAccount");
export const createExecutionId = (): ExecutionId => createIdentifier("execution");
export const createCommandId = (): CommandId => createIdentifier("command");
export const createEventId = (): EventId => createIdentifier("event");
export const createCorrelationId = (): CorrelationId => createIdentifier("correlation");
export const createCausationId = (): CausationId => createIdentifier("causation");
export const createJobId = (): JobId => createIdentifier("job");
export const createApprovalId = (): ApprovalId => createIdentifier("approval");
export const createOpportunityId = (): OpportunityId => createIdentifier("opportunity");
export const createContentRequestId = (): ContentRequestId => createIdentifier("request");
export const createTraceId = (): TraceId => createIdentifier("trace");
export const createSpanId = (): SpanId => createIdentifier("span");
export const createModelId = (): ModelId => createIdentifier("model");
export const createProviderId = (): ProviderId => createIdentifier("provider");
export const createToolId = (): ToolId => createIdentifier("tool");
export const createPolicyId = (): PolicyId => createIdentifier("policy");
export const createBudgetId = (): BudgetId => createIdentifier("budget");
export const createReservationId = (): ReservationId => createIdentifier("reservation");
export const createEvaluationId = (): EvaluationId => createIdentifier("evaluation");
export const createPlanId = (): PlanId => createIdentifier("plan");
