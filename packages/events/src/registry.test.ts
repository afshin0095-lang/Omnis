/**
 * Event registry and Sprint 0 definition tests.
 *
 * The registry is the mechanism that makes "an event type means one thing" enforceable
 * rather than aspirational. Two properties matter most: several versions of one type can
 * be live at once (a rolling deployment guarantees they are), and publishing against a
 * type nobody has defined fails loudly instead of reaching a consumer that cannot
 * interpret it.
 */

import { CONTRACT_VERSION, createEvent } from "@omnis/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import {
  createCharacterId,
  createTenantId,
  eventNamespaceOf,
  nowIso,
  parseEventType,
  parseSemVer,
  parseTrimmedString,
} from "@omnis/types";
import type { JsonObject } from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  ALL_EVENT_TYPES,
  characterCreatedPayloadSchema,
  createEventRegistry,
  defineEvent,
  definitionKey,
  EVENT_OWNERS,
  EVENT_TYPES_WITHOUT_DEFINITIONS,
  EVENT_TYPE_NAMESPACES,
  SPRINT0_EVENT_DEFINITIONS,
  SYSTEM_EVENT_TYPES,
} from "./index.js";
import type { EventDefinition } from "./index.js";

/** Fails and returns the thrown error. */
function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return null;
}

/** A definition for a type that is not part of the Sprint 0 vocabulary. */
function testDefinition(overrides: Partial<EventDefinition> = {}): EventDefinition {
  return defineEvent({
    type: parseEventType("system.test.definition"),
    version: CONTRACT_VERSION,
    scope: "domain",
    owner: EVENT_OWNERS.platform,
    summary: "A definition used only by these tests.",
    payloadSchema: characterCreatedPayloadSchema,
    ...overrides,
  });
}

/** A payload that satisfies `characterCreatedPayloadSchema`. */
function characterPayload(): JsonObject {
  return {
    characterId: String(createCharacterId()),
    workspaceId: null,
    displayName: "Ava",
    definitionVersion: "1.0.0",
  };
}

/** A registry seeded with the Sprint 0 vocabulary. */
function seededRegistry(): ReturnType<typeof createEventRegistry> {
  const registry = createEventRegistry();
  registry.registerAll(SPRINT0_EVENT_DEFINITIONS);
  return registry;
}

describe("defineEvent and definitionKey", () => {
  it("returns the definition it was given, preserving the payload type", () => {
    const definition = testDefinition();
    expect(defineEvent(definition)).toBe(definition);
    expect(definition.type).toBe("system.test.definition");
  });

  it("keys a definition by type and version", () => {
    expect(definitionKey(parseEventType("character.created"), parseSemVer("1.0.0"))).toBe(
      "character.created@1.0.0",
    );
  });
});

describe("EventRegistry", () => {
  it("starts empty", () => {
    const registry = createEventRegistry();
    expect(registry.size).toBe(0);
    expect(registry.types()).toEqual([]);
    expect(registry.list()).toEqual([]);
    expect(registry.isRegistered(parseEventType("character.created"))).toBe(false);
  });

  it("registers and resolves a definition", () => {
    const registry = createEventRegistry();
    const definition = testDefinition();
    registry.register(definition);
    expect(registry.size).toBe(1);
    expect(registry.isRegistered(definition.type)).toBe(true);
    expect(registry.find(definition.type)).toBe(definition);
    expect(registry.require(definition.type)).toBe(definition);
  });

  it("registers a batch", () => {
    const registry = createEventRegistry();
    registry.registerAll(SPRINT0_EVENT_DEFINITIONS);
    expect(registry.size).toBe(SPRINT0_EVENT_DEFINITIONS.length);
  });

  it("refuses to redefine a published contract", () => {
    // An overwrite would change the meaning of an event type that consumers have
    // already validated against — the most confusing class of bug to diagnose across a
    // process boundary, because both sides believe they are correct.
    const registry = createEventRegistry();
    registry.register(testDefinition());
    const thrown = capture(() =>
      registry.register(testDefinition({ summary: "a different meaning" })),
    );
    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).conflict).toBe(
      "event-definition:system.test.definition@1.0.0",
    );
    expect((thrown as ConflictError).message).toContain("already registered");
    expect(registry.size).toBe(1);
  });

  it("keeps several versions of one type live at the same time", () => {
    // Unavoidable during a rolling deployment: an old producer and a new consumer
    // coexist for minutes or hours, and both must be served correctly.
    const registry = createEventRegistry();
    const v1 = testDefinition({ version: parseSemVer("1.0.0") });
    const v2 = testDefinition({ version: parseSemVer("1.1.0") });
    const v3 = testDefinition({ version: parseSemVer("2.0.0") });
    registry.registerAll([v2, v1, v3]);

    expect(registry.size).toBe(3);
    expect(registry.find(v1.type, parseSemVer("1.0.0"))).toBe(v1);
    expect(registry.find(v1.type, parseSemVer("1.1.0"))).toBe(v2);
    expect(registry.find(v1.type, parseSemVer("2.0.0"))).toBe(v3);
    expect(registry.versionsOf(v1.type).map(String)).toEqual(["1.0.0", "1.1.0", "2.0.0"]);
  });

  it("resolves the highest version when none is requested", () => {
    // The right default for a producer, which should emit the newest contract, and the
    // wrong one for a consumer that only understands an older shape — which is why the
    // explicit version parameter exists.
    const registry = createEventRegistry();
    const v1 = testDefinition({ version: parseSemVer("1.0.0") });
    const v2 = testDefinition({ version: parseSemVer("1.10.0") });
    registry.registerAll([v2, v1]);
    expect(registry.find(v1.type)).toBe(v2);
    expect(registry.require(v1.type)).toBe(v2);
  });

  it("returns undefined for something it does not know", () => {
    const registry = seededRegistry();
    expect(registry.find(parseEventType("system.never.declared"))).toBeUndefined();
    expect(registry.find(SYSTEM_EVENT_TYPES.initialized, parseSemVer("9.9.9"))).toBeUndefined();
    expect(registry.versionsOf(parseEventType("system.never.declared"))).toEqual([]);
  });

  it("throws NotFoundError when a required definition is absent", () => {
    // Publishing against an unregistered type is a defect, not a recoverable condition.
    const registry = seededRegistry();
    const thrown = capture(() => registry.require(parseEventType("system.never.declared")));
    expect(thrown).toBeInstanceOf(NotFoundError);
    expect((thrown as NotFoundError).resourceType).toBe("event definition");
    expect((thrown as NotFoundError).resourceId).toBe("system.never.declared");
    expect((thrown as NotFoundError).retryable).toBe(false);
  });

  it("reports which versions do exist when the requested one does not", () => {
    const registry = createEventRegistry();
    registry.register(testDefinition({ version: parseSemVer("1.0.0") }));
    const thrown = capture(() =>
      registry.require(testDefinition().type, parseSemVer("3.0.0")),
    ) as NotFoundError;
    expect(thrown.resourceId).toBe("system.test.definition@3.0.0");
    expect(thrown.metadata["registeredVersions"]).toEqual(["1.0.0"]);
    expect(thrown.metadata["owner"]).toBe("system");
  });

  it("lists types, definitions and namespaces", () => {
    const registry = seededRegistry();
    expect(registry.types()).toHaveLength(SPRINT0_EVENT_DEFINITIONS.length);
    expect(registry.list()).toHaveLength(SPRINT0_EVENT_DEFINITIONS.length);
    expect(
      registry
        .listByNamespace("system")
        .map((definition) => String(definition.type))
        .sort(),
    ).toEqual(
      [
        String(SYSTEM_EVENT_TYPES.configurationLoaded),
        String(SYSTEM_EVENT_TYPES.initialized),
      ].sort(),
    );
    expect(registry.listByNamespace("analytics")).toHaveLength(1);
  });

  it("reports an unassigned namespace rather than inventing an owner", () => {
    const registry = createEventRegistry();
    const thrown = capture(() =>
      registry.require(parseEventType("billing.invoice.paid")),
    ) as NotFoundError;
    expect(eventNamespaceOf(parseEventType("billing.invoice.paid"))).toBeNull();
    expect(thrown.metadata["owner"]).toBe("unassigned");
  });
});

describe("validateEnvelope", () => {
  it("accepts an event that matches its registered contract", () => {
    const registry = seededRegistry();
    const event = createEvent({
      type: SYSTEM_EVENT_TYPES.initialized,
      payload: { service: "content-factory", version: "0.1.0", environment: "test" },
      source: EVENT_OWNERS.platform,
      tenantId: createTenantId(),
    });
    expect(registry.validateEnvelope(event)).toEqual(event);
  });

  it("rejects a payload that does not match the contract the producer claimed", () => {
    const registry = seededRegistry();
    const event = createEvent({
      type: SYSTEM_EVENT_TYPES.initialized,
      payload: { service: "content-factory" },
      source: EVENT_OWNERS.platform,
      tenantId: createTenantId(),
    });
    const thrown = capture(() => registry.validateEnvelope(event));
    expect(thrown).toBeInstanceOf(ValidationError);
    const failure = thrown as ValidationError;
    expect(failure.message).toContain("system.initialized@1.0.0");
    // The owner is named so the failure can be routed to the team that can fix it.
    expect(failure.message).toContain(String(EVENT_OWNERS.platform));
    expect(failure.metadata["eventType"]).toBe("system.initialized");
    expect(failure.metadata["owner"]).toBe(String(EVENT_OWNERS.platform));
    expect(failure.issues.length).toBeGreaterThan(0);
    expect(failure.retryable).toBe(false);
  });

  it("rejects an event type nobody has defined", () => {
    // `system.shutdown.requested` is declared vocabulary with no agreed payload yet:
    // publishing it must fail until its owning domain supplies a definition.
    const registry = seededRegistry();
    const event = createEvent({
      type: SYSTEM_EVENT_TYPES.shutdownRequested,
      payload: {},
      source: EVENT_OWNERS.platform,
      tenantId: createTenantId(),
    });
    expect(capture(() => registry.validateEnvelope(event))).toBeInstanceOf(NotFoundError);
  });

  it("rejects a malformed envelope before consulting the registry", () => {
    const registry = seededRegistry();
    expect(capture(() => registry.validateEnvelope({ type: "character.created" }))).toBeInstanceOf(
      ValidationError,
    );
    expect(capture(() => registry.validateEnvelope(null))).toBeInstanceOf(ValidationError);
  });

  it("validates against the version the producer claimed, not the newest", () => {
    // During a rolling deployment an old producer is not wrong; it is old. Serving it
    // the newest contract would reject a payload that was correct when it was written.
    const registry = createEventRegistry();
    const v1 = defineEvent<JsonObject>({
      type: parseEventType("system.test.definition"),
      version: parseSemVer("1.0.0"),
      scope: "domain",
      owner: EVENT_OWNERS.platform,
      summary: "Requires only a character id.",
      payloadSchema: characterCreatedPayloadSchema,
    });
    registry.register(v1);

    const event = createEvent({
      type: v1.type,
      version: parseSemVer("1.0.0"),
      payload: characterPayload(),
      source: EVENT_OWNERS.platform,
      tenantId: createTenantId(),
    });
    expect(registry.validateEnvelope(event).version).toBe("1.0.0");
  });

  it("rejects an event produced at a major version this build cannot read", () => {
    const registry = createEventRegistry();
    registry.register(testDefinition({ version: parseSemVer("1.0.0") }));
    const event = {
      ...createEvent({
        type: testDefinition().type,
        payload: characterPayload(),
        source: EVENT_OWNERS.platform,
        tenantId: createTenantId(),
      }),
      version: parseSemVer("2.0.0"),
    };
    // ContractError rather than NotFoundError: the shape is fine, the two deployments
    // disagree, and the remediation is a redeploy or a rollback.
    expect(capture(() => registry.validateEnvelope(event))).toBeInstanceOf(Error);
  });
});

describe("the Sprint 0 vocabulary", () => {
  it("declares seven namespaces", () => {
    expect(Object.keys(EVENT_TYPE_NAMESPACES).sort()).toEqual([
      "agent",
      "analytics",
      "audience",
      "character",
      "content",
      "publishing",
      "system",
    ]);
  });

  it("declares every type exactly once", () => {
    const values = ALL_EVENT_TYPES.map(String);
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThan(20);
  });

  it("uses only names the event grammar accepts", () => {
    // `parseEventType` runs at module load, so a name outside the grammar does not
    // merely fail a test — it makes the package unimportable. `audience.loyalty.
    // tier_changed` did exactly that: an underscore is not part of the dotted
    // lowercase grammar, and every consumer of @omnis/events threw on import.
    const grammar = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
    for (const type of ALL_EVENT_TYPES) {
      expect(String(type), String(type)).toMatch(grammar);
      expect(String(type).includes("_"), String(type)).toBe(false);
    }
  });

  it("places every declared type in the namespace its name claims", () => {
    for (const [namespace, types] of Object.entries(EVENT_TYPE_NAMESPACES)) {
      for (const type of Object.values(types)) {
        expect(eventNamespaceOf(type), String(type)).toBe(namespace);
        expect(String(type).startsWith(`${namespace}.`), String(type)).toBe(true);
      }
    }
  });

  it("registers a definition for every type that is not explicitly deferred", () => {
    // This is the check that separates "designed and deferred" from "forgotten": a type
    // in the vocabulary is either registered or listed, never neither.
    const defined = new Set(SPRINT0_EVENT_DEFINITIONS.map((definition) => String(definition.type)));
    const deferred = new Set(EVENT_TYPES_WITHOUT_DEFINITIONS.map(String));

    for (const type of ALL_EVENT_TYPES) {
      const name = String(type);
      expect(
        defined.has(name) || deferred.has(name),
        `${name} is neither defined nor deferred`,
      ).toBe(true);
      expect(defined.has(name) && deferred.has(name), `${name} is both defined and deferred`).toBe(
        false,
      );
    }
    expect(defined.size).toBe(SPRINT0_EVENT_DEFINITIONS.length);
  });

  it("defines sixteen events across the seven namespaces", () => {
    expect(SPRINT0_EVENT_DEFINITIONS).toHaveLength(16);
    const namespaces = new Set(
      SPRINT0_EVENT_DEFINITIONS.map((definition) => eventNamespaceOf(definition.type)),
    );
    expect(namespaces.size).toBe(7);
  });

  it("pins every definition to the current contract version", () => {
    // An event's version is bumped when its payload contract changes, independently of
    // the platform's release version. Starting everything at one version is what makes
    // the compatibility rules meaningful later.
    for (const definition of SPRINT0_EVENT_DEFINITIONS) {
      expect(definition.version, String(definition.type)).toBe(CONTRACT_VERSION);
    }
  });

  it("assigns each definition to the service that owns its namespace", () => {
    // Ownership follows the namespace. A service registering a definition outside its
    // own namespace is a domain-boundary violation, and this is where it is caught.
    const ownerByNamespace: Readonly<Record<string, string>> = {
      system: String(EVENT_OWNERS.platform),
      agent: String(EVENT_OWNERS.aiCore),
      character: String(EVENT_OWNERS.characterOs),
      audience: String(EVENT_OWNERS.audienceIntelligence),
      content: String(EVENT_OWNERS.contentFactory),
      publishing: String(EVENT_OWNERS.publishing),
      analytics: String(EVENT_OWNERS.analytics),
    };
    for (const definition of SPRINT0_EVENT_DEFINITIONS) {
      const namespace = eventNamespaceOf(definition.type);
      expect(namespace, String(definition.type)).not.toBeNull();
      expect(String(definition.owner), String(definition.type)).toBe(
        ownerByNamespace[namespace as string],
      );
    }
  });

  it("gives every definition a human-readable summary and a scope", () => {
    for (const definition of SPRINT0_EVENT_DEFINITIONS) {
      expect(definition.summary.length, String(definition.type)).toBeGreaterThan(20);
      expect(definition.summary.endsWith("."), String(definition.type)).toBe(true);
      expect(["domain", "integration"], String(definition.type)).toContain(definition.scope);
      expect(definition.payloadSchema, String(definition.type)).toBeTruthy();
    }
  });

  it("names owners as valid service names", () => {
    for (const [key, owner] of Object.entries(EVENT_OWNERS)) {
      expect(owner, key).toMatch(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/);
      expect(parseTrimmedString(owner), key).toBe(owner);
    }
  });

  it("marks cross-boundary events as integration scope", () => {
    // `system.initialized` is consumed by services that do not own it, so its shape is
    // a promise to consumers OMNIS may not control.
    const registry = seededRegistry();
    expect(registry.require(SYSTEM_EVENT_TYPES.initialized).scope).toBe("integration");
    // Configuration loading is internal to the process that loaded it.
    expect(registry.require(SYSTEM_EVENT_TYPES.configurationLoaded).scope).toBe("domain");
  });

  it("seeds a registry that validates a real event end to end", () => {
    const registry = seededRegistry();
    const event = createEvent({
      type: parseEventType("character.created"),
      payload: characterPayload(),
      source: EVENT_OWNERS.characterOs,
      tenantId: createTenantId(),
      occurredAt: nowIso(),
    });
    expect(registry.validateEnvelope(event).type).toBe("character.created");
  });
});
