import { describe, expect, it } from "vitest";
import {
  createAgentId,
  createCommandId,
  createEventId,
  createExecutionId,
  createTenantId,
} from "@omnis/types";
import { newCorrelationId } from "./Correlation.js";
import {
  causationFromCommand,
  causationFromEvent,
  childIdentity,
  hasCausation,
  identityOf,
  inheritCorrelation,
  isRootContext,
  lineageOf,
} from "./Correlation.js";
import { createExecutionContextFactory } from "./ExecutionContextFactory.js";
import { manualClock } from "./Clock.js";

const factory = createExecutionContextFactory({ clock: manualClock(1_000) });

describe("correlation", () => {
  it("mints distinct correlation identifiers", () => {
    const first = newCorrelationId();
    const second = newCorrelationId();
    expect(first).toMatch(/^cor_/);
    expect(first).not.toBe(second);
  });

  it("inherits the parent correlation identifier unchanged", () => {
    const correlationId = newCorrelationId();
    expect(inheritCorrelation(correlationId)).toBe(correlationId);
  });

  it("propagates one correlation through a whole scope tree", () => {
    const root = factory.createRootScope();
    const child = root.child();
    const grandchild = child.child();
    expect(child.context.correlationId).toBe(root.context.correlationId);
    expect(grandchild.context.correlationId).toBe(root.context.correlationId);
  });
});

describe("causation", () => {
  it("is derived from a command or an event, never from an execution", () => {
    const commandId = createCommandId();
    const eventId = createEventId();
    expect(causationFromCommand(commandId)).toBe(commandId);
    expect(causationFromEvent(eventId)).toBe(eventId);
    // A causation reference keeps the prefix of the message it came from, so an audit
    // query can tell a command-caused execution from an event-caused one. Internal
    // parentage is carried by `parentExecutionId` instead: `asCausationId` in
    // `@omnis/types` accepts only command and event identifiers, which is the rule that
    // keeps a causal chain a chain of *messages*.
    expect(causationFromCommand(commandId).startsWith("cmd_")).toBe(true);
    expect(causationFromEvent(eventId).startsWith("evt_")).toBe(true);
  });

  it("marks a context caused by a message", () => {
    const caused = factory.createRootScope({
      causationId: causationFromCommand(createCommandId()),
    });
    const internal = factory.createRootScope();
    expect(hasCausation(caused.context)).toBe(true);
    expect(hasCausation(internal.context)).toBe(false);
  });
});

describe("root and lineage", () => {
  it("recognizes a root context", () => {
    const root = factory.createRootScope();
    expect(isRootContext(root.context)).toBe(true);

    const caused = factory.createRootScope({ causationId: causationFromEvent(createEventId()) });
    expect(isRootContext(caused.context)).toBe(false);

    const child = root.child();
    expect(isRootContext(child.context)).toBe(false);
    expect(child.context.parentExecutionId).toBe(root.context.executionId);
  });

  it("projects the fields needed to reconstruct a lineage", () => {
    const agentId = createAgentId();
    const tenantId = createTenantId();
    const root = factory.createRootScope({ agentId, tenantId });
    const child = root.child();

    expect(lineageOf(child.context)).toEqual({
      executionId: child.context.executionId,
      parentExecutionId: root.context.executionId,
      correlationId: root.context.correlationId,
      causationId: null,
      depth: 1,
    });
    expect(lineageOf(root.context).depth).toBe(0);
  });
});

describe("identity", () => {
  it("carries the execution and correlation identifiers of a context", () => {
    const root = factory.createRootScope();
    expect(identityOf(root.context)).toEqual({
      executionId: root.context.executionId,
      correlationId: root.context.correlationId,
      causationId: null,
      traceId: null,
      parentSpanId: null,
    });
  });

  it("builds a child identity that inherits correlation and trace", () => {
    const parent = identityOf(factory.createRootScope().context);
    const childExecutionId = createExecutionId();
    const child = childIdentity(parent, childExecutionId);
    expect(child.correlationId).toBe(parent.correlationId);
    expect(child.executionId).toBe(childExecutionId);
    expect(child.parentSpanId).toBeNull();
  });
});
