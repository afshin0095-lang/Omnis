/**
 * Domain events vs integration events.
 *
 * WHY THE DISTINCTION EXISTS
 * --------------------------
 * A domain event belongs to one domain and describes something that happened
 * inside it: `character.experience.recorded` is Character OS talking to itself and
 * to closely-coupled collaborators. Its shape may evolve with the domain.
 *
 * An integration event crosses a boundary — to another service, another team, or
 * an external consumer. Once published, its shape is a promise. Changing it can
 * break code OMNIS does not control.
 *
 * If every event were implicitly public, the platform could never refactor a
 * domain. If every event were implicitly private, nothing could integrate. Making
 * the scope an explicit, typed field means the distinction is enforced by the
 * compiler and visible in the event store, rather than being tribal knowledge.
 *
 * THE RULE
 * --------
 * Only `integration` events may cross a process, service or organisational
 * boundary. A `domain` event that leaves its domain is a design defect, and the
 * architecture tests treat an unscoped event as one.
 *
 * Promotion is a deliberate act: {@link promoteToIntegrationEvent} is the only
 * supported way to turn a domain event into an integration event, so the point at
 * which a shape becomes a public promise is always explicit and reviewable.
 */

import type { JsonObject } from "@omnis/types";
import type { EventEnvelope, EventScope } from "./envelope.js";
import { EVENT_SCOPES } from "./envelope.js";

/**
 * An event whose scope is confined to the domain that produced it.
 *
 * Structurally identical to {@link EventEnvelope} with `scope` narrowed, so any
 * code that accepts an envelope also accepts a domain event.
 */
export type DomainEvent<TPayload extends JsonObject = JsonObject> = EventEnvelope<TPayload> & {
  readonly scope: "domain";
};

/**
 * An event that has been published across a boundary and whose shape is now a
 * versioned promise to consumers OMNIS may not control.
 */
export type IntegrationEvent<TPayload extends JsonObject = JsonObject> = EventEnvelope<TPayload> & {
  readonly scope: "integration";
};

/** Type guard narrowing an envelope to a domain event. */
export function isDomainEvent<TPayload extends JsonObject>(
  event: EventEnvelope<TPayload>,
): event is DomainEvent<TPayload> {
  return event.scope === "domain";
}

/** Type guard narrowing an envelope to an integration event. */
export function isIntegrationEvent<TPayload extends JsonObject>(
  event: EventEnvelope<TPayload>,
): event is IntegrationEvent<TPayload> {
  return event.scope === "integration";
}

/** Type guard for the scope discriminator itself. */
export function isEventScope(value: unknown): value is EventScope {
  return typeof value === "string" && (EVENT_SCOPES as readonly string[]).includes(value);
}

/**
 * Promotes a domain event to an integration event.
 *
 * Returns a **new** envelope rather than mutating the original: the domain event
 * usually still needs to be handled locally, and mutating a shared `readonly`
 * record would be both a type lie and a source of spooky action at a distance.
 *
 * Promotion is intentionally cheap — it changes one field — because the real work
 * of making an event safe to publish is done elsewhere and earlier: the payload
 * must already be JSON-safe (enforced by the envelope schema), the type must
 * already be registered (enforced by the event registry), and the version must
 * already follow the compatibility rules. This function exists so that the moment
 * of publication is explicit in the code, not so that it can perform validation.
 */
export function promoteToIntegrationEvent<TPayload extends JsonObject>(
  event: EventEnvelope<TPayload>,
): IntegrationEvent<TPayload> {
  return { ...event, scope: "integration" };
}

/**
 * Demotes an integration event back to domain scope.
 *
 * Provided for symmetry and for inbound events: a consumer that receives an
 * integration event from another service and handles it internally should treat
 * it as a domain-local fact from that point on, so that its own re-publication
 * decisions are made deliberately rather than inherited.
 */
export function toDomainEvent<TPayload extends JsonObject>(
  event: EventEnvelope<TPayload>,
): DomainEvent<TPayload> {
  return { ...event, scope: "domain" };
}
