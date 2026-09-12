/**
 * What it means to define an event type.
 *
 * A definition is the whole agreement between a producer and its consumers: the
 * name, the payload shape, the version of that shape, how far the event may
 * travel, who owns it and what it means. Registering one is what turns a string
 * constant into a contract that can be validated, routed and evolved.
 *
 * `owner` is not decoration. When a malformed event appears in the stream, or a
 * payload needs a breaking change, `owner` is how the platform finds who has the
 * authority to make that decision. An event without an owner is an event nobody
 * can safely change.
 */

import type { EventType, JsonObject, SemVer } from "@omnis/types";
import type { EventScope, ServiceName } from "@omnis/contracts";
import type { OmnisSchema } from "@omnis/validation";

/** A registered, versioned event contract. */
export interface EventDefinition<TPayload extends JsonObject = JsonObject> {
  /** The dotted event type this definition describes. */
  readonly type: EventType;
  /** The contract version of `payloadSchema`. */
  readonly version: SemVer;
  /** How far this event may travel. */
  readonly scope: EventScope;
  /**
   * The service that owns this contract and may change it.
   *
   * Ownership follows the event's namespace: `character.*` belongs to
   * Character OS, `audience.*` to Audience Intelligence, and so on. A service
   * registering a definition outside its own namespace is a boundary violation
   * and the architecture tests treat it as one.
   */
  readonly owner: ServiceName;
  /** One-sentence description of what happened, written for a human reader. */
  readonly summary: string;
  /** Runtime schema for the payload. */
  readonly payloadSchema: OmnisSchema<TPayload>;
}

/**
 * Builds a definition.
 *
 * Thin, but worth having: it is the single place where the shape of a definition
 * is assembled, so a future field — a deprecation date, a documentation link, a
 * retention class — is added once rather than at every registration site. It also
 * preserves the payload's precise generic type, which a plain object literal
 * would widen away.
 */
export function defineEvent<TPayload extends JsonObject>(
  definition: EventDefinition<TPayload>,
): EventDefinition<TPayload> {
  return definition;
}

/** The registry key for a `(type, version)` pair. */
export function definitionKey(type: EventType, version: SemVer): string {
  return `${String(type)}@${String(version)}`;
}
