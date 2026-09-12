/**
 * The event envelope — the single wire format for every OMNIS event.
 *
 * WHY ONE ENVELOPE
 * ----------------
 * OMNIS spans audience ingestion, character evolution, content production,
 * publishing and analytics. If each domain invented its own event wrapper, every
 * consumer would need per-domain parsing, correlation would be impossible across
 * domain boundaries, and the audit trail would have gaps exactly where it matters
 * most. One envelope means one parser, one router, one audit format.
 *
 * FIELD RATIONALE
 * ---------------
 * - `id` — globally unique, time-ordered. Enables idempotent consumption: a
 *   consumer that has already processed an `id` can skip it safely.
 * - `type` — the routing and ownership key (see `@omnis/types` event-type).
 * - `version` — the contract version of the *payload shape*, not of the envelope.
 * - `scope` — whether the event may cross a domain or process boundary. This is
 *   what stops an internal domain event from becoming a de-facto public API.
 * - `occurredAt` — when the thing happened, which is not the same as when the
 *   event was written. Retention windows, loyalty scoring and scheduling all
 *   depend on the former.
 * - `source` — the service that produced it, for attribution and for finding the
 *   owner of a malformed event.
 * - `tenantId` — isolation. Present on every event without exception.
 * - `correlationId` / `causationId` — the business-operation chain and the
 *   immediate trigger. Both, because either alone is insufficient to reconstruct
 *   a causal graph.
 * - `actor` — attribution for authorization, audit and approval gating.
 *
 * NULLABLE VS OPTIONAL
 * --------------------
 * Fields that may legitimately be absent are typed `T | null` and **always
 * present in the serialized form**, rather than being optional. An optional key
 * disappears under `JSON.stringify`, which makes "absent" and "explicitly none"
 * indistinguishable on the wire and makes schema evolution ambiguous: a consumer
 * cannot tell whether an older producer omitted the field or asserted it was
 * empty. A `null` is an assertion; a missing key is a guess.
 *
 * UNKNOWN KEYS
 * ------------
 * The envelope schema strips unknown top-level keys instead of rejecting them.
 * This is a deliberate forward-compatibility choice: when a newer producer adds a
 * field, older consumers must keep working rather than start failing. Adding a
 * field is a minor version bump precisely because it is safe to ignore.
 */

import type {
  CausationId,
  CorrelationId,
  EventId,
  EventType,
  JsonObject,
  SemVer,
  TenantId,
  UtcTimestamp,
} from "@omnis/types";
import {
  asCausationId,
  createCorrelationId,
  createEventId,
  nowIso,
  semVerParts,
} from "@omnis/types";
import { ContractError } from "@omnis/errors";
import {
  eventTypeSchema,
  causationIdSchema,
  identifierSchemas,
  isoDateTimeSchema,
  jsonObjectSchema,
  semVerSchema,
  validate,
  z,
} from "@omnis/validation";
import type { ActorContext, ServiceName } from "./context.js";
import { actorContextSchema, serviceNameSchema } from "./context.js";
import { CONTRACT_VERSION, formatContractId } from "./version.js";

/** Whether an event may cross a domain or process boundary. */
export const EVENT_SCOPES = ["domain", "integration"] as const;

/** One member of {@link EVENT_SCOPES}. */
export type EventScope = (typeof EVENT_SCOPES)[number];

/** Stable contract identifier used in errors, logs and the registry. */
export const EVENT_ENVELOPE_CONTRACT_ID = "EventEnvelope";

/**
 * The wire format shared by every OMNIS event.
 *
 * `TPayload` defaults to {@link JsonObject}; domain event definitions narrow it
 * to their own payload type so producers and consumers agree structurally.
 */
export type EventEnvelope<TPayload extends JsonObject = JsonObject> = {
  readonly id: EventId;
  readonly type: EventType;
  readonly version: SemVer;
  readonly scope: EventScope;
  readonly occurredAt: UtcTimestamp;
  readonly source: ServiceName;
  readonly tenantId: TenantId;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
  readonly actor: ActorContext | null;
  readonly payload: TPayload;
};

/** Schema for an {@link EventEnvelope} carrying an arbitrary JSON payload. */
export const eventEnvelopeSchema = z.object({
  id: identifierSchemas.event,
  type: eventTypeSchema,
  version: semVerSchema,
  scope: z.enum(EVENT_SCOPES),
  occurredAt: isoDateTimeSchema,
  source: serviceNameSchema,
  tenantId: identifierSchemas.tenant,
  correlationId: identifierSchemas.correlation,
  causationId: causationIdSchema.nullable().default(null),
  actor: actorContextSchema.nullable().default(null),
  payload: jsonObjectSchema,
});

/**
 * Validates an unknown value as an {@link EventEnvelope}.
 *
 * Raises `ValidationError` (from `@omnis/errors`, thrown by {@link validate}) for a
 * malformed envelope and {@link ContractError} for a well-formed envelope whose major
 * version this build cannot interpret. Those are different failures with different remediations: the
 * first means the producer has a bug, the second means two deployments disagree
 * and one must be updated or rolled back.
 */
export function parseEventEnvelope(input: unknown): EventEnvelope {
  const envelope = validate(
    eventEnvelopeSchema,
    input,
    formatContractId(EVENT_ENVELOPE_CONTRACT_ID, CONTRACT_VERSION),
  );
  assertInterpretableVersion(envelope.version, envelope.type);
  return envelope;
}

/**
 * Rejects an event version this build cannot safely interpret.
 *
 * Compatibility is "same major". A higher minor is fine (additive); a different
 * major is not, because the payload shape may have changed meaning.
 */
export function assertInterpretableVersion(version: SemVer, type: EventType): void {
  const produced = semVerParts(version);
  const supported = semVerParts(CONTRACT_VERSION);
  if (produced.major !== supported.major) {
    throw new ContractError(
      String(type),
      `Event was produced at contract version ${String(version)}, which this build ` +
        `(supporting ${String(CONTRACT_VERSION)}) cannot interpret.`,
      {
        contractVersion: String(CONTRACT_VERSION),
        receivedVersion: String(version),
        retryable: false,
      },
    );
  }
}

/** Everything a caller must supply to mint an event. */
export type NewEvent<TPayload extends JsonObject = JsonObject> = {
  readonly type: EventType;
  readonly payload: TPayload;
  readonly source: ServiceName;
  readonly tenantId: TenantId;
  /** Defaults to a fresh correlation, i.e. this event starts a new chain. */
  readonly correlationId?: CorrelationId;
  readonly causationId?: CausationId | null;
  readonly actor?: ActorContext | null;
  /** Defaults to {@link CONTRACT_VERSION}. */
  readonly version?: SemVer;
  /** Defaults to {@link EVENT_SCOPES}[0], `"domain"`. */
  readonly scope?: EventScope;
  /** Defaults to the current instant. */
  readonly occurredAt?: UtcTimestamp;
};

/**
 * Mints a well-formed {@link EventEnvelope}.
 *
 * Generating `id` and defaulting `occurredAt`, `version`, `scope` and
 * `correlationId` here — rather than at each call site — is what guarantees the
 * invariants hold everywhere. A hand-built envelope that forgot `correlationId`
 * would still typecheck if the field were optional; this factory makes the
 * omission impossible.
 */
export function createEvent<TPayload extends JsonObject = JsonObject>(
  input: NewEvent<TPayload>,
): EventEnvelope<TPayload> {
  return {
    id: createEventId(),
    type: input.type,
    version: input.version ?? CONTRACT_VERSION,
    scope: input.scope ?? "domain",
    occurredAt: input.occurredAt ?? nowIso(),
    source: input.source,
    tenantId: input.tenantId,
    correlationId: input.correlationId ?? createCorrelationId(),
    causationId: input.causationId ?? null,
    actor: input.actor ?? null,
    payload: input.payload,
  };
}

/**
 * Derives a follow-on event that continues the same business operation.
 *
 * The new event inherits `tenantId`, `correlationId`, `source` and `actor`, and
 * sets its `causationId` to the parent event's `id` — which is exactly the
 * parent/child link that makes a causal graph reconstructible from the event
 * store without any extra bookkeeping.
 */
export function createCausedEvent<TPayload extends JsonObject = JsonObject>(
  cause: EventEnvelope,
  input: Omit<
    NewEvent<TPayload>,
    "tenantId" | "correlationId" | "causationId" | "source" | "actor"
  > & {
    readonly source?: ServiceName;
    readonly actor?: ActorContext | null;
  },
): EventEnvelope<TPayload> {
  return createEvent<TPayload>({
    ...input,
    source: input.source ?? cause.source,
    actor: input.actor === undefined ? cause.actor : input.actor,
    tenantId: cause.tenantId,
    correlationId: cause.correlationId,
    // The causation identifier is the causing *event*'s own identifier: one
    // namespace, no separate "caused by event" field to keep in sync.
    causationId: asCausationId(cause.id),
  });
}
