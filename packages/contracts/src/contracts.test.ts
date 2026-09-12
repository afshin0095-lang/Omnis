/**
 * Contract tests: versioning rules, execution context and the event envelope.
 *
 * These are the agreements that outlive any single service. An envelope that parses
 * here is read by a consumer OMNIS may not control, so the interesting cases are the
 * ones where two deployments disagree — a newer producer, an older consumer, a field
 * that used to be required.
 */

import { ContractError, ValidationError } from "@omnis/errors";
import {
  asCausationId,
  createAgentId,
  createCorrelationId,
  createEventId,
  createExecutionId,
  createTenantId,
  createUserId,
  createWorkspaceId,
  parseEventType,
  parseSemVer,
  parseTrimmedString,
} from "@omnis/types";
import type { JsonObject } from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  ACTOR_KINDS,
  assertInterpretableVersion,
  classifyVersionChange,
  CONTRACT_CHANGE_KINDS,
  CONTRACT_VERSION,
  createCausedEvent,
  createEvent,
  EVENT_ENVELOPE_CONTRACT_ID,
  EVENT_SCOPES,
  formatContractId,
  isAutonomousActor,
  isBackwardsCompatible,
  isDomainEvent,
  isEventScope,
  isHumanActor,
  isIntegrationEvent,
  isProductionContext,
  nextVersion,
  parseActorContext,
  parseEventEnvelope,
  parseExecutionContext,
  parseTenantContext,
  promoteToIntegrationEvent,
  serviceActor,
  SYSTEM_ACTOR,
  toDomainEvent,
} from "./index.js";
import type { ActorContext, EventEnvelope, ExecutionContext } from "./index.js";

/** Fails and returns the thrown error. */
function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return null;
}

/** A minimal execution context, valid in every field. */
function sampleContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const parsed = parseExecutionContext({
    executionId: createExecutionId(),
    correlationId: createCorrelationId(),
    tenant: { tenantId: createTenantId() },
    environment: "test",
    ...overrides,
  });
  return parsed;
}

/** A minimal well-formed envelope. */
function sampleEvent(payload: JsonObject = { characterId: "chr_1" }): EventEnvelope {
  return createEvent({
    type: parseEventType("character.created"),
    payload,
    source: parseTrimmedString("character-os"),
    tenantId: createTenantId(),
  });
}

describe("contract versioning", () => {
  it("pins the contract version this build speaks", () => {
    expect(CONTRACT_VERSION).toBe("1.0.0");
    expect(formatContractId("EventEnvelope", CONTRACT_VERSION)).toBe("EventEnvelope@1.0.0");
    expect(formatContractId(EVENT_ENVELOPE_CONTRACT_ID, parseSemVer("2.3.4"))).toBe(
      "EventEnvelope@2.3.4",
    );
  });

  it("declares the three change kinds", () => {
    expect(CONTRACT_CHANGE_KINDS).toEqual(["patch", "minor", "major"]);
  });

  it("computes the next version for each change kind", () => {
    // Centralised so "bump the minor" cannot be an off-by-one in one package.
    expect(nextVersion(parseSemVer("1.2.3"), "patch")).toBe("1.2.4");
    expect(nextVersion(parseSemVer("1.2.3"), "minor")).toBe("1.3.0");
    expect(nextVersion(parseSemVer("1.2.3"), "major")).toBe("2.0.0");
    expect(nextVersion(parseSemVer("0.1.0"), "major")).toBe("1.0.0");
  });

  it("classifies a transition by the highest component that moved", () => {
    expect(classifyVersionChange(parseSemVer("1.2.3"), parseSemVer("1.2.4"))).toBe("patch");
    expect(classifyVersionChange(parseSemVer("1.2.3"), parseSemVer("1.3.0"))).toBe("minor");
    expect(classifyVersionChange(parseSemVer("1.2.3"), parseSemVer("2.0.0"))).toBe("major");
    expect(classifyVersionChange(parseSemVer("1.2.3"), parseSemVer("1.2.3"))).toBe("patch");
  });

  it("treats same-major-and-not-older as backwards compatible", () => {
    // Within a major, changes must be additive, so an older consumer ignores what it
    // does not know. Across a major, no such promise exists.
    expect(isBackwardsCompatible(parseSemVer("1.0.0"), parseSemVer("1.0.0"))).toBe(true);
    expect(isBackwardsCompatible(parseSemVer("1.0.0"), parseSemVer("1.4.0"))).toBe(true);
    expect(isBackwardsCompatible(parseSemVer("1.0.0"), parseSemVer("2.0.0"))).toBe(false);
    expect(isBackwardsCompatible(parseSemVer("2.0.0"), parseSemVer("1.9.0"))).toBe(false);
  });

  it("refuses to call an older version compatible with a newer consumer", () => {
    expect(isBackwardsCompatible(parseSemVer("1.4.0"), parseSemVer("1.0.0"))).toBe(false);
  });

  it("does not treat a pre-release as a stable contract", () => {
    // A consumer written against 1.0.0 cannot rely on 1.1.0-rc.1: the shape is still
    // allowed to change before the release.
    expect(isBackwardsCompatible(parseSemVer("1.0.0"), parseSemVer("1.1.0-rc.1"))).toBe(false);
    expect(isBackwardsCompatible(parseSemVer("1.0.0-rc.1"), parseSemVer("1.0.0-rc.2"))).toBe(true);
  });
});

describe("tenant context", () => {
  it("requires a tenant and defaults the optional scopes to null", () => {
    // OMNIS has no untenanted data: an envelope without a tenant cannot be attributed,
    // and an unattributable record cannot be safely acted on.
    const tenantId = createTenantId();
    const context = parseTenantContext({ tenantId });
    expect(context).toEqual({ tenantId, workspaceId: null, region: null });
  });

  it("accepts a workspace and a residency hint", () => {
    const workspaceId = createWorkspaceId();
    const context = parseTenantContext({
      tenantId: createTenantId(),
      workspaceId,
      region: "eu-central",
    });
    expect(context.workspaceId).toBe(workspaceId);
    expect(context.region).toBe("eu-central");
  });

  it("rejects a missing or malformed tenant", () => {
    expect(capture(() => parseTenantContext({}))).toBeInstanceOf(ValidationError);
    expect(capture(() => parseTenantContext({ tenantId: "ten_1" }))).toBeInstanceOf(
      ValidationError,
    );
    expect(capture(() => parseTenantContext({ tenantId: createUserId() }))).toBeInstanceOf(
      ValidationError,
    );
    expect(capture(() => parseTenantContext(null))).toBeInstanceOf(ValidationError);
  });

  it("names the contract in the failure", () => {
    const thrown = capture(() => parseTenantContext({})) as ValidationError;
    expect(thrown.message).toContain(`TenantContext@${CONTRACT_VERSION}`);
  });
});

describe("actor context", () => {
  it("accepts each kind of principal", () => {
    const userId = createUserId();
    const agentId = createAgentId();
    expect(parseActorContext({ kind: "user", id: userId })).toEqual({
      kind: "user",
      id: userId,
      displayName: null,
    });
    expect(parseActorContext({ kind: "agent", id: agentId })).toEqual({
      kind: "agent",
      id: agentId,
      onBehalfOf: null,
      displayName: null,
    });
    expect(parseActorContext({ kind: "service", name: "content-factory" })).toEqual({
      kind: "service",
      name: "content-factory",
    });
    expect(parseActorContext({ kind: "system" })).toEqual({ kind: "system" });
  });

  it("declares four actor kinds", () => {
    expect(ACTOR_KINDS).toEqual(["user", "agent", "service", "system"]);
  });

  it("rejects an identifier of the wrong kind for the actor", () => {
    // A discriminated union is what stops `kind: "system"` arriving with a UserId. A
    // bag of optional fields would typecheck that and then leave authorization
    // guessing which principal actually acted.
    expect(capture(() => parseActorContext({ kind: "user", id: createAgentId() }))).toBeInstanceOf(
      ValidationError,
    );
    expect(capture(() => parseActorContext({ kind: "agent", id: createUserId() }))).toBeInstanceOf(
      ValidationError,
    );
    expect(capture(() => parseActorContext({ kind: "unknown" }))).toBeInstanceOf(ValidationError);
    expect(capture(() => parseActorContext({ kind: "service" }))).toBeInstanceOf(ValidationError);
  });

  it("records who an agent acts on behalf of", () => {
    // The distinction between "agent X decided this" and "agent X decided this because
    // user Y authorised it" is what an approval gate reads.
    const onBehalfOf = createUserId();
    const actor = parseActorContext({ kind: "agent", id: createAgentId(), onBehalfOf });
    expect(actor.kind).toBe("agent");
    if (actor.kind === "agent") {
      expect(actor.onBehalfOf).toBe(onBehalfOf);
    }
  });

  it("builds the two common actors", () => {
    expect(serviceActor(parseTrimmedString("content-factory"))).toEqual({
      kind: "service",
      name: "content-factory",
    });
    expect(SYSTEM_ACTOR).toEqual({ kind: "system" });
  });

  it("classifies human and autonomous actors", () => {
    const human: ActorContext = {
      kind: "user",
      id: createUserId(),
      displayName: null,
    };
    const agent: ActorContext = {
      kind: "agent",
      id: createAgentId(),
      onBehalfOf: null,
      displayName: null,
    };

    expect(isHumanActor(human)).toBe(true);
    expect(isAutonomousActor(human)).toBe(false);
    // An agent acting on a human's behalf is still autonomous: the human is not in the
    // loop at the moment of the action, which is exactly when a gate must apply.
    expect(isAutonomousActor(agent)).toBe(true);
    expect(isHumanActor(agent)).toBe(false);
    expect(isAutonomousActor(serviceActor(parseTrimmedString("svc")))).toBe(true);
    expect(isAutonomousActor(SYSTEM_ACTOR)).toBe(true);

    // Every actor kind is in exactly one of the two sets.
    for (const actor of [human, agent, serviceActor(parseTrimmedString("svc")), SYSTEM_ACTOR]) {
      expect(isHumanActor(actor) !== isAutonomousActor(actor), actor.kind).toBe(true);
    }
  });
});

describe("execution context", () => {
  it("defaults the optional trace and deadline fields", () => {
    const context = sampleContext();
    expect(context.causationId).toBeNull();
    expect(context.actor).toBeNull();
    expect(context.traceId).toBeNull();
    expect(context.parentSpanId).toBeNull();
    expect(context.deadlineMs).toBeNull();
    expect(context.environment).toBe("test");
  });

  it("requires the identifiers that make work traceable", () => {
    expect(capture(() => parseExecutionContext({}))).toBeInstanceOf(ValidationError);
    expect(
      capture(() =>
        parseExecutionContext({
          correlationId: createCorrelationId(),
          tenant: { tenantId: createTenantId() },
          environment: "test",
        }),
      ),
    ).toBeInstanceOf(ValidationError);
  });

  it("accepts a full context including an actor and a deadline", () => {
    const context = sampleContext({
      actor: SYSTEM_ACTOR,
      deadlineMs: 5000,
      causationId: asCausationId(createEventId()),
    });
    expect(context.actor).toEqual(SYSTEM_ACTOR);
    expect(context.deadlineMs).toBe(5000);
    expect(context.causationId).toBeTruthy();
  });

  it("rejects a deadline that cannot be honoured", () => {
    // A zero or negative deadline would make every operation time out on arrival, and
    // a fractional one is not a millisecond count.
    expect(capture(() => sampleContext({ deadlineMs: 0 }))).toBeInstanceOf(ValidationError);
    expect(capture(() => sampleContext({ deadlineMs: -1 }))).toBeInstanceOf(ValidationError);
    expect(capture(() => sampleContext({ deadlineMs: 1.5 }))).toBeInstanceOf(ValidationError);
  });

  it("recognises a production context", () => {
    expect(isProductionContext(sampleContext({ environment: "production" }))).toBe(true);
    expect(isProductionContext(sampleContext({ environment: "staging" }))).toBe(false);
    expect(isProductionContext(sampleContext({ environment: "test" }))).toBe(false);
  });

  it("normalises an environment abbreviation on the wire", () => {
    expect(sampleContext({ environment: "production" }).environment).toBe("production");
    const parsed = parseExecutionContext({
      executionId: createExecutionId(),
      correlationId: createCorrelationId(),
      tenant: { tenantId: createTenantId() },
      environment: "prod",
    });
    expect(parsed.environment).toBe("production");
  });
});

describe("the event envelope", () => {
  it("mints an identity and defaults the fields a producer should not have to think about", () => {
    const event = sampleEvent();
    expect(String(event.id).startsWith("evt_")).toBe(true);
    expect(event.version).toBe(CONTRACT_VERSION);
    expect(event.scope).toBe("domain");
    expect(String(event.correlationId).startsWith("cor_")).toBe(true);
    expect(event.causationId).toBeNull();
    expect(event.actor).toBeNull();
    expect(event.occurredAt).toMatch(/Z$/);
    expect(event.source).toBe("character-os");
  });

  it("honours values the producer supplied", () => {
    const correlationId = createCorrelationId();
    const eventId = createEventId();
    const event = createEvent({
      type: parseEventType("content.production.completed"),
      payload: {},
      source: parseTrimmedString("content-factory"),
      tenantId: createTenantId(),
      correlationId,
      causationId: asCausationId(eventId),
      actor: SYSTEM_ACTOR,
      scope: "integration",
      version: parseSemVer("1.1.0"),
    });
    expect(event.correlationId).toBe(correlationId);
    expect(event.causationId).toBe(String(eventId));
    expect(event.actor).toEqual(SYSTEM_ACTOR);
    expect(event.scope).toBe("integration");
    expect(event.version).toBe("1.1.0");
  });

  it("gives every minted event a distinct identity", () => {
    const ids = new Set(Array.from({ length: 50 }, () => sampleEvent().id));
    expect(ids.size).toBe(50);
  });

  it("round-trips through JSON", () => {
    const event = sampleEvent();
    expect(parseEventEnvelope(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("strips an unknown top-level field rather than rejecting it", () => {
    // Forward compatibility: when a newer producer adds a field, older consumers must
    // keep working rather than start failing. Adding a field is a minor bump precisely
    // because it is safe to ignore.
    const wire = { ...JSON.parse(JSON.stringify(sampleEvent())), futureField: "hello" };
    const parsed = parseEventEnvelope(wire);
    expect("futureField" in parsed).toBe(false);
    expect(parsed.type).toBe("character.created");
  });

  it("rejects a payload that is not JSON-safe", () => {
    // The failure this prevents is an event accepted locally and then silently dropped
    // by a JSON transport.
    expect(
      capture(() =>
        parseEventEnvelope({
          ...JSON.parse(JSON.stringify(sampleEvent())),
          payload: { at: Number.NaN },
        }),
      ),
    ).toBeInstanceOf(ValidationError);
  });

  it("rejects a malformed envelope", () => {
    const wire = JSON.parse(JSON.stringify(sampleEvent())) as Record<string, unknown>;
    for (const field of [
      "id",
      "type",
      "version",
      "scope",
      "occurredAt",
      "source",
      "tenantId",
      "payload",
    ]) {
      const broken = { ...wire };
      delete broken[field];
      expect(
        capture(() => parseEventEnvelope(broken)),
        field,
      ).toBeInstanceOf(ValidationError);
    }
    expect(capture(() => parseEventEnvelope({ ...wire, scope: "internal" }))).toBeInstanceOf(
      ValidationError,
    );
    expect(
      capture(() => parseEventEnvelope({ ...wire, type: "Character.Created" })),
    ).toBeInstanceOf(ValidationError);
  });

  it("rejects an event whose major version this build cannot interpret", () => {
    const wire = { ...JSON.parse(JSON.stringify(sampleEvent())), version: "2.0.0" };
    const thrown = capture(() => parseEventEnvelope(wire));
    expect(thrown).toBeInstanceOf(ContractError);
    const failure = thrown as ContractError;
    expect(failure.contractId).toBe("character.created");
    expect(failure.contractVersion).toBe(CONTRACT_VERSION);
    expect(failure.receivedVersion).toBe("2.0.0");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("cannot interpret");
  });

  it("accepts a higher minor version from a newer producer", () => {
    // Additive changes within a major are exactly what an older consumer must tolerate.
    const wire = { ...JSON.parse(JSON.stringify(sampleEvent())), version: "1.7.0" };
    expect(parseEventEnvelope(wire).version).toBe("1.7.0");
  });

  it("reports the version check separately from the shape check", () => {
    expect(() =>
      assertInterpretableVersion(parseSemVer("1.9.0"), parseEventType("a.b")),
    ).not.toThrow();
    expect(() => assertInterpretableVersion(parseSemVer("2.0.0"), parseEventType("a.b"))).toThrow(
      ContractError,
    );
  });
});

describe("event scope", () => {
  it("declares the two scopes", () => {
    expect(EVENT_SCOPES).toEqual(["domain", "integration"]);
    expect(isEventScope("domain")).toBe(true);
    expect(isEventScope("integration")).toBe(true);
    expect(isEventScope("internal")).toBe(false);
    expect(isEventScope(7)).toBe(false);
  });

  it("narrows with the scope guards", () => {
    const event = sampleEvent();
    expect(isDomainEvent(event)).toBe(true);
    expect(isIntegrationEvent(event)).toBe(false);
    const promoted = promoteToIntegrationEvent(event);
    expect(isDomainEvent(promoted)).toBe(false);
    expect(isIntegrationEvent(promoted)).toBe(true);
  });

  it("returns a new envelope when promoting, leaving the original alone", () => {
    // The domain event usually still has to be handled locally, and mutating a shared
    // readonly record would be both a type lie and spooky action at a distance.
    const event = sampleEvent();
    const promoted = promoteToIntegrationEvent(event);
    expect(promoted).not.toBe(event);
    expect(event.scope).toBe("domain");
    expect(promoted.scope).toBe("integration");
    expect(promoted.id).toBe(event.id);
    expect(promoted.payload).toEqual(event.payload);
  });

  it("demotes an inbound integration event back to domain scope", () => {
    // A consumer handling someone else's integration event internally should make its
    // own re-publication decision rather than inherit one.
    const inbound = promoteToIntegrationEvent(sampleEvent());
    const local = toDomainEvent(inbound);
    expect(local.scope).toBe("domain");
    expect(inbound.scope).toBe("integration");
    expect(local.id).toBe(inbound.id);
  });
});

describe("createCausedEvent", () => {
  it("links the new event to its cause and continues the correlation", () => {
    const cause = sampleEvent();
    const effect = createCausedEvent(cause, {
      type: parseEventType("content.production.started"),
      payload: { step: "render" },
    });

    // This parent/child link is what makes a causal graph reconstructible from the
    // event store without any extra bookkeeping.
    expect(effect.causationId).toBe(String(cause.id));
    expect(effect.correlationId).toBe(cause.correlationId);
    expect(effect.tenantId).toBe(cause.tenantId);
    expect(effect.source).toBe(cause.source);
    expect(effect.actor).toBe(cause.actor);
    expect(effect.id).not.toBe(cause.id);
    expect(effect.type).toBe("content.production.started");
  });

  it("lets the causing service hand off to a different source and actor", () => {
    const cause = sampleEvent();
    const effect = createCausedEvent(cause, {
      type: parseEventType("publishing.scheduled"),
      payload: {},
      source: parseTrimmedString("publishing-gateway"),
      actor: serviceActor(parseTrimmedString("publishing-gateway")),
    });
    expect(effect.source).toBe("publishing-gateway");
    expect(effect.actor).toEqual({ kind: "service", name: "publishing-gateway" });
    expect(effect.correlationId).toBe(cause.correlationId);
  });

  it("keeps the tenant of the causing event, whatever the caller passes", () => {
    // A follow-on event that changed tenant would move one tenant's workload into
    // another's history.
    const cause = sampleEvent();
    const effect = createCausedEvent(cause, {
      type: parseEventType("character.updated"),
      payload: {},
    });
    expect(effect.tenantId).toBe(cause.tenantId);
  });

  it("produces an envelope its own schema accepts", () => {
    // The regression this guards: `asCausationId` keeps the causing event's `evt_`
    // value, so a causation field validated against the strict `cau_` schema rejected
    // every caused event. The chain was well formed in memory and unpublishable on the
    // wire, which is the worst place to discover a contract bug.
    const effect = createCausedEvent(sampleEvent(), {
      type: parseEventType("content.production.started"),
      payload: {},
    });
    expect(() => parseEventEnvelope(JSON.parse(JSON.stringify(effect)))).not.toThrow();
    expect(parseEventEnvelope(JSON.parse(JSON.stringify(effect))).causationId).toBe(
      effect.causationId,
    );
    expect(() =>
      parseExecutionContext({ ...sampleContext(), causationId: effect.causationId }),
    ).not.toThrow();
  });

  it("produces a chain that can be walked back to its origin", () => {
    const first = sampleEvent();
    const second = createCausedEvent(first, {
      type: parseEventType("content.production.started"),
      payload: {},
    });
    const third = createCausedEvent(second, {
      type: parseEventType("content.production.completed"),
      payload: {},
    });

    expect(third.correlationId).toBe(first.correlationId);
    expect(third.causationId).toBe(String(second.id));
    expect(second.causationId).toBe(String(first.id));
    expect(first.causationId).toBeNull();
  });
});
