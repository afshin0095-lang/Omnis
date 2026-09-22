import { describe, expect, it } from "vitest";
import { parseExecutionContext, SYSTEM_ACTOR } from "@omnis/contracts";
import { ValidationError } from "@omnis/errors";
import {
  createAgentId,
  createCausationId,
  createCorrelationId,
  createExecutionId,
  createSpanId,
  createTenantId,
  createTraceId,
  createUserId,
  createWorkspaceId,
  parseTrimmedString,
} from "@omnis/types";
import { manualClock } from "./Clock.js";
import { createDeadline } from "./Deadline.js";
import {
  actorFor,
  isSameRun,
  remainingContractMs,
  scopeOptionsFromContract,
  toContractContext,
} from "./ContractContext.js";
import { createExecutionContextFactory } from "./ExecutionContextFactory.js";
import { ExecutionScope } from "./ExecutionScope.js";

const NOW = 1_700_000_000_000;
const clock = manualClock(NOW);
const factory = createExecutionContextFactory({ clock });

/** An execution with a tenant, an agent and a deadline: the interesting case. */
function execution() {
  return factory.createContext({
    executionId: createExecutionId(),
    correlationId: createCorrelationId(),
    causationId: createCausationId(),
    tenantId: createTenantId(),
    agentId: createAgentId(),
    traceId: createTraceId(),
    parentSpanId: createSpanId(),
    deadline: createDeadline(NOW, 30_000),
  });
}

describe("projecting an execution onto a contract envelope", () => {
  it("produces an envelope the contract itself accepts", () => {
    // The strongest thing this bridge can promise: not "the fields look right" but "the
    // platform's own parser, with the platform's own schema, accepts the result".
    const projected = toContractContext(execution(), { environment: "production" });
    expect(() => parseExecutionContext(projected)).not.toThrow();
    expect(parseExecutionContext(projected)).toEqual(projected);
  });

  it("carries the identity across unchanged", () => {
    const context = execution();
    const projected = toContractContext(context, { environment: "staging" });

    expect(projected.executionId).toBe(context.executionId);
    expect(projected.correlationId).toBe(context.correlationId);
    expect(projected.causationId).toBe(context.causationId);
    expect(projected.tenant.tenantId).toBe(context.tenantId);
    expect(projected.traceId).toBe(context.traceId);
    expect(projected.parentSpanId).toBe(context.parentSpanId);
    expect(projected.environment).toBe("staging");
  });

  it("records the allowance the execution was given, not what is left of it", () => {
    const context = execution();
    clock.advance(29_000);
    // An envelope is a record of intent. "30s" is still the truth after 29s have passed;
    // "1s" would be a number that is stale the moment it is written down.
    expect(toContractContext(context, { environment: "test" }).deadlineMs).toBe(30_000);
  });

  it("records no deadline for an unbounded execution", () => {
    const context = factory.createContext({ tenantId: createTenantId() });
    expect(toContractContext(context, { environment: "development" }).deadlineMs).toBeNull();
  });

  it("refuses to project an execution that has no tenant", () => {
    const context = factory.createContext({ agentId: createAgentId() });
    expect(context.tenantId).toBeNull();

    let raised: unknown = null;
    try {
      toContractContext(context, { environment: "production" });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ValidationError);
    // An envelope with no tenant describes work belonging to nobody, and every consumer
    // of the contract isolates by tenant.
    expect((raised as ValidationError).issues[0]?.path).toBe("tenantId");
  });

  it("records the workspace and region only when the caller has them", () => {
    const workspaceId = createWorkspaceId();
    const region = parseTrimmedString("eu-central");
    const plain = toContractContext(execution(), { environment: "test" });
    expect(plain.tenant.workspaceId).toBeNull();
    expect(plain.tenant.region).toBeNull();

    const scoped = toContractContext(execution(), { environment: "test", workspaceId, region });
    expect(scoped.tenant.workspaceId).toBe(workspaceId);
    expect(scoped.tenant.region).toBe(region);
  });
});

describe("attribution", () => {
  it("attributes an agent execution to that agent, and invents no delegating human", () => {
    const context = execution();
    const actor = actorFor(context);
    expect(actor.kind).toBe("agent");
    if (actor.kind === "agent") {
      expect(actor.id).toBe(context.agentId);
      // The AI Core does not know who authorised the work. Saying "on behalf of nobody"
      // is true; naming a user would put a human in an audit trail for a decision they
      // did not make.
      expect(actor.onBehalfOf).toBeNull();
    }
  });

  it("attributes an execution with no agent to the platform", () => {
    const context = factory.createContext({ tenantId: createTenantId() });
    expect(actorFor(context)).toEqual(SYSTEM_ACTOR);
  });

  it("uses the actor the caller supplied, which is how a human delegation is recorded", () => {
    const userId = createUserId();
    const agentId = createAgentId();
    const context = factory.createContext({ tenantId: createTenantId(), agentId });
    const projected = toContractContext(context, {
      environment: "production",
      actor: { kind: "agent", id: agentId, onBehalfOf: userId, displayName: null },
    });
    expect(projected.actor).toEqual({
      kind: "agent",
      id: agentId,
      onBehalfOf: userId,
      displayName: null,
    });
  });

  it("accepts a human actor for work a human started", () => {
    const userId = createUserId();
    const projected = toContractContext(execution(), {
      environment: "production",
      actor: { kind: "user", id: userId, displayName: null },
    });
    expect(() => parseExecutionContext(projected)).not.toThrow();
    expect(projected.actor?.kind).toBe("user");
  });
});

describe("measuring an envelope", () => {
  it("reports what is left of an allowance, and never a negative number", () => {
    const contract = toContractContext(execution(), { environment: "test" });
    expect(remainingContractMs(contract, NOW, NOW)).toBe(30_000);
    expect(remainingContractMs(contract, NOW + 12_000, NOW)).toBe(18_000);
    expect(remainingContractMs(contract, NOW + 60_000, NOW)).toBe(0);
  });

  it("reports null for an envelope with no deadline", () => {
    const context = factory.createContext({ tenantId: createTenantId() });
    expect(
      remainingContractMs(toContractContext(context, { environment: "test" }), NOW, NOW),
    ).toBeNull();
  });
});

describe("adopting an inbound envelope", () => {
  it("carries the identity into the options a scope is opened with", () => {
    const context = execution();
    const contract = toContractContext(context, { environment: "production" });
    const options = scopeOptionsFromContract(contract);

    expect(options.executionId).toBe(context.executionId);
    expect(options.correlationId).toBe(context.correlationId);
    expect(options.causationId).toBe(context.causationId);
    expect(options.tenantId).toBe(context.tenantId);
    expect(options.traceId).toBe(context.traceId);
    expect(options.parentSpanId).toBe(context.parentSpanId);
    expect(options.deadlineMs).toBe(30_000);
  });

  it("produces a scope whose context is the same run", () => {
    const context = execution();
    const contract = toContractContext(context, { environment: "production" });
    // A run started by a command has to join that command's correlation chain. If the
    // bridge lost the correlation identifier, the execution would be correct and
    // unreachable: nothing would tie it back to the request that caused it.
    const scope = ExecutionScope.createRoot(scopeOptionsFromContract(contract), { clock });
    expect(isSameRun(scope.context, contract)).toBe(true);
    expect(scope.context.correlationId).toBe(context.correlationId);
  });

  it("takes the agent identifier from an agent actor only", () => {
    const agentId = createAgentId();
    const context = factory.createContext({ tenantId: createTenantId(), agentId });
    const contract = toContractContext(context, { environment: "test" });
    expect(scopeOptionsFromContract(contract).agentId).toBe(agentId);

    const human = toContractContext(context, {
      environment: "test",
      actor: { kind: "user", id: createUserId(), displayName: null },
    });
    // A human actor is recorded in the metadata, not as the agent: the AI Core's
    // `agentId` names the agent doing the work.
    expect(scopeOptionsFromContract(human).agentId).toBeNull();
    expect(scopeOptionsFromContract(human).metadata).toMatchObject({ actorKind: "user" });
  });

  it("records the environment and the actor's shape in metadata, as strings only", () => {
    const userId = createUserId();
    const workspaceId = createWorkspaceId();
    const contract = toContractContext(execution(), {
      environment: "staging",
      actor: { kind: "user", id: userId, displayName: parseTrimmedString("Operator") },
      workspaceId,
      region: parseTrimmedString("eu-central"),
    });
    const metadata = scopeOptionsFromContract(contract).metadata ?? {};

    expect(metadata).toMatchObject({
      environment: "staging",
      actorKind: "user",
      actorId: String(userId),
      workspaceId: String(workspaceId),
      region: "eu-central",
    });
    for (const value of Object.values(metadata)) {
      // Metadata is stored and forwarded; an identifier object in it would be serialized
      // by whatever writer received it, which is how a branded value becomes "{}".
      expect(typeof value).toBe("string");
    }
  });

  it("records who a service actor is, and who an agent was acting for", () => {
    const serviceContract = toContractContext(execution(), {
      environment: "production",
      actor: { kind: "service", name: parseTrimmedString("content-factory") },
    });
    expect(scopeOptionsFromContract(serviceContract).metadata).toMatchObject({
      actorKind: "service",
      serviceName: "content-factory",
    });

    const userId = createUserId();
    const delegated = toContractContext(execution(), {
      environment: "production",
      actor: { kind: "agent", id: createAgentId(), onBehalfOf: userId, displayName: null },
    });
    expect(scopeOptionsFromContract(delegated).metadata).toMatchObject({
      actorKind: "agent",
      onBehalfOf: String(userId),
    });
  });

  it("says when an envelope has no actor at all", () => {
    const context = execution();
    const contract = { ...toContractContext(context, { environment: "test" }), actor: null };
    expect(scopeOptionsFromContract(contract).metadata).toMatchObject({ actorKind: "unknown" });
  });
});

describe("comparing the two shapes", () => {
  it("recognizes the same run", () => {
    const context = execution();
    expect(isSameRun(context, toContractContext(context, { environment: "test" }))).toBe(true);
  });

  it("does not confuse two runs that share a tenant", () => {
    const tenantId = createTenantId();
    const first = factory.createContext({ tenantId });
    const second = factory.createContext({ tenantId });
    expect(isSameRun(first, toContractContext(second, { environment: "test" }))).toBe(false);
  });

  it("does not confuse two runs that share a correlation", () => {
    // One business operation spans many executions by design, so correlation alone is not
    // identity: a bridge that treated it as such would merge two runs into one record.
    const correlationId = createCorrelationId();
    const tenantId = createTenantId();
    const first = factory.createContext({ correlationId, tenantId });
    const second = factory.createContext({ correlationId, tenantId });
    expect(String(first.executionId)).not.toBe(String(second.executionId));
    expect(isSameRun(first, toContractContext(second, { environment: "test" }))).toBe(false);
  });
});
