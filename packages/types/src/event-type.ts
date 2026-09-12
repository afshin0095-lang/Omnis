/**
 * Dotted event type names.
 *
 * WHY a validated shape
 * ---------------------
 * An event type is the primary routing and versioning key for the whole platform:
 * the event registry indexes by it, consumers subscribe by it, dashboards group
 * by it, and the first segment determines which domain owns it. If the shape is
 * unconstrained, `character.created`, `CharacterCreated`, `character_created` and
 * `character.created.v2` all appear in the same stream and none of the routing,
 * grouping or ownership rules work.
 *
 * FORMAT
 * ------
 * ```text
 * <domain>.<subject>[.<qualifier>...]      e.g. character.experience.recorded
 * ```
 * - Lowercase `snake`-free segments, dot-separated, at least two segments.
 * - The first segment is the owning domain and must be one of the recognised
 *   event namespaces.
 * - Segments are stable: renaming one is a breaking contract change requiring an
 *   ADR, because persisted events already carry it.
 */

import type { Branded } from "./brand.js";
import { unsafeBrand } from "./brand.js";
import { InvalidValueError } from "./errors.js";
import { parseFailure, parseSuccess, type ParseResult } from "./parse.js";

/** A validated, dotted event type name. */
export type EventType = Branded<string, "EventType">;

/**
 * The recognised top-level event namespaces.
 *
 * These mirror the OMNIS domain map: every event belongs to exactly one owning
 * domain, and the namespace is how that ownership is visible on the wire.
 */
export const EVENT_NAMESPACES = [
  "system",
  "agent",
  "character",
  "audience",
  "content",
  "publishing",
  "analytics",
] as const;

/** One member of {@link EVENT_NAMESPACES}. */
export type EventNamespace = (typeof EVENT_NAMESPACES)[number];

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/** Validates a dotted event type name. */
export function tryParseEventType(value: unknown): ParseResult<EventType> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  if (value.length > 128) {
    return parseFailure(`expected at most 128 characters, received ${value.length}`);
  }
  if (!EVENT_TYPE_PATTERN.test(value)) {
    return parseFailure(
      "expected a lowercase dotted name of at least two segments, e.g. character.created",
    );
  }
  return parseSuccess(unsafeBrand<EventType>(value));
}

/** Throwing variant of {@link tryParseEventType}. */
export function parseEventType(value: unknown): EventType {
  const result = tryParseEventType(value);
  if (!result.ok) {
    throw new InvalidValueError(
      "EventType",
      result.reason,
      typeof value === "string" ? value : undefined,
    );
  }
  return result.value;
}

/** Type guard form of {@link tryParseEventType}. */
export function isEventType(value: unknown): value is EventType {
  return tryParseEventType(value).ok;
}

/**
 * Extracts the owning namespace (the first segment) of an event type.
 *
 * Returns `null` when the first segment is not a recognised namespace, which is
 * how the event registry detects an event published by a domain that does not
 * own it.
 */
export function eventNamespaceOf(eventType: EventType): EventNamespace | null {
  const head = eventType.slice(0, eventType.indexOf("."));
  return (EVENT_NAMESPACES as readonly string[]).includes(head) ? (head as EventNamespace) : null;
}

/**
 * A validated, dotted command name.
 *
 * Commands use the same dotted shape as events but are **imperative** rather than
 * past-tense: `content.production.start`, not `content.production.started`. The
 * distinction is worth enforcing in the vocabulary even though the grammar is
 * identical, because a command is a request that may be rejected or require
 * approval, whereas an event is a fact that has already happened and cannot be
 * vetoed. Confusing the two is how systems end up "publishing events" that
 * silently command side effects.
 */
export type CommandName = Branded<string, "CommandName">;

/** Validates a dotted command name. */
export function tryParseCommandName(value: unknown): ParseResult<CommandName> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  if (value.length > 128) {
    return parseFailure(`expected at most 128 characters, received ${value.length}`);
  }
  if (!EVENT_TYPE_PATTERN.test(value)) {
    return parseFailure(
      "expected a lowercase dotted name of at least two segments, e.g. content.production.start",
    );
  }
  return parseSuccess(unsafeBrand<CommandName>(value));
}

/** Throwing variant of {@link tryParseCommandName}. */
export function parseCommandName(value: unknown): CommandName {
  const result = tryParseCommandName(value);
  if (!result.ok) {
    throw new InvalidValueError(
      "CommandName",
      result.reason,
      typeof value === "string" ? value : undefined,
    );
  }
  return result.value;
}

/** Type guard form of {@link tryParseCommandName}. */
export function isCommandName(value: unknown): value is CommandName {
  return tryParseCommandName(value).ok;
}

/** Splits an event type into its dot-separated segments. */
export function eventTypeSegments(eventType: EventType): readonly string[] {
  return eventType.split(".");
}
