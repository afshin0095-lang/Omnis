/**
 * The typed event registry.
 *
 * WHY A REGISTRY
 * --------------
 * Without one, "which events exist, what do their payloads look like, who owns
 * them and which versions are in flight" is answered by grepping. With one, it is
 * answered by asking — at runtime, in production, from a dashboard or a
 * consumer's startup check.
 *
 * The registry is also the enforcement point for three rules that are otherwise
 * only conventions:
 *
 * 1. **Nothing unregistered may be published.** A typo in an event type becomes a
 *    startup or publish-time failure instead of a stream that silently fills with
 *    events nobody consumes.
 * 2. **Versions are explicit.** Two incompatible payloads cannot share a type
 *    name; they must differ by version, and a consumer resolves the version it
 *    understands.
 * 3. **Payloads are validated where they are produced**, not discovered to be
 *    malformed three services downstream.
 *
 * CONCURRENCY
 * -----------
 * A registry is built during startup and then treated as read-only. It is not
 * synchronized for concurrent mutation, because runtime registration would make
 * the set of valid events depend on timing — which is exactly the
 * non-determinism the registry exists to remove.
 */

import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import type { EventNamespace, EventType, SemVer } from "@omnis/types";
import { compareSemVer, eventNamespaceOf } from "@omnis/types";
import type { EventEnvelope } from "@omnis/contracts";
import { parseEventEnvelope } from "@omnis/contracts";
import { summariseIssues, toValidationIssues } from "@omnis/validation";
import type { EventDefinition } from "./definition.js";
import { definitionKey } from "./definition.js";

/**
 * A registry of event definitions, keyed by type and then by version.
 *
 * The two-level map is what allows several versions of one event type to be live
 * at the same time, which is unavoidable during a rolling deployment: an old
 * producer and a new consumer coexist for minutes or hours, and both must be
 * served correctly.
 */
export class EventRegistry {
  private readonly byType = new Map<string, Map<string, EventDefinition>>();

  /**
   * Registers a definition.
   *
   * @throws {ConflictError} when the same `(type, version)` is registered twice.
   *   Re-registering is refused rather than silently overwriting, because an
   *   overwrite would change the meaning of an event type that consumers have
   *   already validated against — the most confusing class of bug to diagnose
   *   across a process boundary.
   */
  register(definition: EventDefinition): void {
    const type = String(definition.type);
    const version = String(definition.version);

    const versions = this.byType.get(type);
    if (versions?.has(version)) {
      throw new ConflictError(
        `event-definition:${definitionKey(definition.type, definition.version)}`,
        `Event "${type}@${version}" is already registered. Register a new version instead of ` +
          `redefining an existing one; a published contract must not change meaning.`,
      );
    }

    if (versions === undefined) {
      this.byType.set(type, new Map([[version, definition]]));
    } else {
      versions.set(version, definition);
    }
  }

  /** Registers several definitions at once. */
  registerAll(definitions: readonly EventDefinition[]): void {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /** True when at least one version of `type` is registered. */
  isRegistered(type: EventType): boolean {
    return this.byType.has(String(type));
  }

  /**
   * Resolves a definition.
   *
   * Without `version`, the **highest** registered version is returned. That is
   * the right default for a producer (emit the newest contract) and the wrong one
   * for a consumer that only understands an older shape — such a consumer must ask
   * for its version explicitly, which is why the parameter exists.
   */
  find(type: EventType, version?: SemVer): EventDefinition | undefined {
    const versions = this.byType.get(String(type));
    if (versions === undefined || versions.size === 0) {
      return undefined;
    }
    if (version !== undefined) {
      return versions.get(String(version));
    }
    let highest: EventDefinition | undefined;
    for (const candidate of versions.values()) {
      if (highest === undefined || compareSemVer(candidate.version, highest.version) > 0) {
        highest = candidate;
      }
    }
    return highest;
  }

  /**
   * Resolves a definition or throws.
   *
   * @throws {NotFoundError} when the type, or that specific version of it, is not
   *   registered. Publishing against an unregistered type is a defect, not a
   *   recoverable condition, so it fails loudly.
   */
  require(type: EventType, version?: SemVer): EventDefinition {
    const definition = this.find(type, version);
    if (definition === undefined) {
      const detail = version === undefined ? type : `${String(type)}@${String(version)}`;
      throw new NotFoundError("event definition", String(detail), {
        metadata: {
          registeredVersions: this.versionsOf(type).map((known) => String(known)),
          owner: eventNamespaceOf(type) ?? "unassigned",
        },
        retryable: false,
      });
    }
    return definition;
  }

  /** Every registered version of a type, newest last. */
  versionsOf(type: EventType): readonly SemVer[] {
    const versions = this.byType.get(String(type));
    if (versions === undefined) {
      return [];
    }
    return [...versions.values()].map((definition) => definition.version).sort(compareSemVer);
  }

  /** Every registered event type, sorted for stable output. */
  types(): readonly EventType[] {
    const seen = new Map<string, EventType>();
    for (const versions of this.byType.values()) {
      for (const definition of versions.values()) {
        seen.set(String(definition.type), definition.type);
      }
    }
    return [...seen.values()].sort((left, right) => String(left).localeCompare(String(right)));
  }

  /** Every registered definition, sorted by type then version. */
  list(): readonly EventDefinition[] {
    return [...this.byType.values()]
      .flatMap((versions) => [...versions.values()])
      .sort(
        (left, right) =>
          String(left.type).localeCompare(String(right.type)) ||
          compareSemVer(left.version, right.version),
      );
  }

  /** Every registered definition belonging to one namespace. */
  listByNamespace(namespace: EventNamespace): readonly EventDefinition[] {
    return this.list().filter((definition) => eventNamespaceOf(definition.type) === namespace);
  }

  /**
   * Validates an envelope's payload against its registered definition.
   *
   * Two distinct failures are possible and they are deliberately reported
   * differently:
   * - the envelope itself is malformed, or its major version is unsupported
   *   ({@link parseEventEnvelope} raises `ValidationError` / `ContractError`);
   * - the envelope is well formed but the payload does not match the contract the
   *   producer claimed, which raises {@link ValidationError} naming the event
   *   type and version.
   */
  validateEnvelope(envelope: unknown): EventEnvelope {
    const parsed = parseEventEnvelope(envelope);
    const definition = this.require(parsed.type, parsed.version);
    const result = definition.payloadSchema.safeParse(parsed.payload);
    if (!result.success) {
      const issues = toValidationIssues(result.error);
      throw new ValidationError(
        `Payload for "${String(parsed.type)}@${String(parsed.version)}" does not match the ` +
          `registered contract owned by ${String(definition.owner)}: ` +
          `${summariseIssues(issues)}`,
        {
          issues,
          metadata: {
            eventType: String(parsed.type),
            contractVersion: String(parsed.version),
            owner: String(definition.owner),
          },
          retryable: false,
        },
      );
    }
    return parsed;
  }

  /** Number of registered `(type, version)` pairs. */
  get size(): number {
    let total = 0;
    for (const versions of this.byType.values()) {
      total += versions.size;
    }
    return total;
  }
}

/** Creates an empty registry. */
export function createEventRegistry(): EventRegistry {
  return new EventRegistry();
}
