/**
 * Command, result and approval-gate tests.
 *
 * A command is the only way OMNIS changes state, and its result is the only way a
 * caller learns what happened. The three statuses are not interchangeable: `failed`
 * means the handler ran, `rejected` means a policy stopped it before it did, and only
 * `rejected` can carry an approval. Conflating them is how a system ends up retrying
 * an action a human explicitly refused.
 */

import { PolicyViolationError, ProviderError, ValidationError } from "@omnis/errors";
import type { SerializedOmnisError } from "@omnis/errors";
import {
  createApprovalId,
  createCommandId,
  createCorrelationId,
  createEventId,
  createExecutionId,
  createTenantId,
  createUserId,
  nowIso,
  parseCommandName,
  parseTrimmedString,
} from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_REQUEST_CONTRACT_ID,
  COMMAND_CONTRACT_ID,
  COMMAND_RESULT_CONTRACT_ID,
  COMMAND_RESULT_STATUSES,
  CONTRACT_VERSION,
  createApprovalRequest,
  createCommand,
  formatContractId,
  isAwaitingApproval,
  parseApprovalRequest,
  parseCommand,
  parseCommandResult,
  parseExecutionContext,
  parseSerializedError,
  RISK_LEVELS,
  SYSTEM_ACTOR,
} from "./index.js";
import type { ApprovalRequest, CommandResult, ExecutionContext } from "./index.js";

/** Fails and returns the thrown error. */
function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return null;
}

/** A valid execution context. */
function sampleContext(): ExecutionContext {
  return parseExecutionContext({
    executionId: createExecutionId(),
    correlationId: createCorrelationId(),
    tenant: { tenantId: createTenantId() },
    environment: "test",
  });
}

/** A valid serialized error, as one crosses a process boundary. */
function sampleSerializedError(): SerializedOmnisError {
  return new ValidationError("rejected").serialize();
}

/** A valid approval request. */
function sampleApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return createApprovalRequest({
    policyId: parseTrimmedString("policy.autonomy.publish"),
    reason: parseTrimmedString("spend above the daily cap"),
    risk: "high",
    requestedBy: SYSTEM_ACTOR,
    expiresAt: null,
    ...overrides,
  });
}

describe("serialized errors on the wire", () => {
  it("accepts an error produced by the error hierarchy", () => {
    const error = new ProviderError("openai", "rate limited", {
      providerRef: "req_1",
      retryable: true,
      retryAfterMs: 2000,
    });
    const parsed = parseSerializedError(JSON.parse(JSON.stringify(error)) as unknown);
    expect(parsed.code).toBe("provider_failure");
    expect(parsed.retryable).toBe(true);
    expect(parsed.retryAfterMs).toBe(2000);
    expect(parsed.metadata["providerRef"]).toBe("req_1");
  });

  it("rejects a code outside the vocabulary", () => {
    // Adopting an unknown code would put an invalid value into a typed field and break
    // every consumer that switches on it.
    const wire = { ...sampleSerializedError(), code: "quantum_decoherence" };
    expect(capture(() => parseSerializedError(wire))).toBeInstanceOf(ValidationError);
  });

  it("requires the fields a consumer needs in order to act", () => {
    const base = JSON.parse(JSON.stringify(sampleSerializedError())) as Record<string, unknown>;
    for (const field of ["name", "code", "message", "metadata", "retryable", "occurredAt"]) {
      const broken = { ...base };
      delete broken[field];
      expect(
        capture(() => parseSerializedError(broken)),
        field,
      ).toBeInstanceOf(ValidationError);
    }
  });

  it("accepts a nested cause and rejects a malformed one", () => {
    const withCause = new ProviderError("openai", "outer", {
      cause: new ValidationError("inner"),
    }).serialize();
    expect(parseSerializedError(JSON.parse(JSON.stringify(withCause))).cause).toBeTruthy();

    expect(
      capture(() => parseSerializedError({ ...sampleSerializedError(), cause: 42 })),
    ).toBeInstanceOf(ValidationError);
    expect(
      parseSerializedError({ ...sampleSerializedError(), cause: { message: "plain" } }).cause,
    ).toEqual({ message: "plain" });
  });

  it("does not carry a stack unless the producer chose to include one", () => {
    expect("stack" in parseSerializedError(sampleSerializedError())).toBe(false);
    const withStack = new ValidationError("rejected").serialize({ includeStack: true });
    expect(typeof parseSerializedError(withStack).stack).toBe("string");
  });
});

describe("approval requests", () => {
  it("declares four risk levels in ascending order", () => {
    expect(RISK_LEVELS).toEqual(["low", "medium", "high", "critical"]);
  });

  it("mints an identity and a request time", () => {
    const approval = sampleApproval();
    expect(String(approval.id).startsWith("apr_")).toBe(true);
    expect(approval.requestedAt).toMatch(/Z$/);
    expect(approval.expiresAt).toBeNull();
  });

  it("keeps a supplied identity and timestamp", () => {
    const id = createApprovalId();
    const requestedAt = nowIso();
    const approval = createApprovalRequest({
      policyId: parseTrimmedString("p"),
      reason: parseTrimmedString("r"),
      risk: "low",
      requestedBy: SYSTEM_ACTOR,
      expiresAt: null,
      requestedAt,
    });
    expect(approval.requestedAt).toBe(requestedAt);
    // `createApprovalRequest` always mints a new id: an approval is a distinct decision
    // point, and reusing one would let a second action inherit a granted approval.
    expect(approval.id).not.toBe(id);
  });

  it("round-trips through JSON", () => {
    const approval = sampleApproval({ expiresAt: nowIso() });
    expect(parseApprovalRequest(JSON.parse(JSON.stringify(approval)))).toEqual(approval);
  });

  it("rejects an approval with no stated policy, reason or risk", () => {
    // An approver has to be able to decide without going hunting. An approval request
    // that does not say which policy raised it, or why, cannot be acted on.
    const wire = JSON.parse(JSON.stringify(sampleApproval())) as Record<string, unknown>;
    for (const field of ["id", "policyId", "reason", "risk", "requestedBy", "requestedAt"]) {
      const broken = { ...wire };
      delete broken[field];
      expect(
        capture(() => parseApprovalRequest(broken)),
        field,
      ).toBeInstanceOf(ValidationError);
    }
    expect(capture(() => parseApprovalRequest({ ...wire, risk: "extreme" }))).toBeInstanceOf(
      ValidationError,
    );
  });

  it("names the contract in a failure", () => {
    const thrown = capture(() => parseApprovalRequest({})) as ValidationError;
    expect(thrown.message).toContain(
      formatContractId(APPROVAL_REQUEST_CONTRACT_ID, CONTRACT_VERSION),
    );
  });

  it("records the principal that asked, including an agent acting for a human", () => {
    const onBehalfOf = createUserId();
    const approval = sampleApproval({
      requestedBy: {
        kind: "agent",
        id: parseTrimmedString("agt_01ARZ3NDEKTSV4RRFFQ69G5FAV") as never,
        onBehalfOf,
        displayName: null,
      },
    });
    expect(parseApprovalRequest(JSON.parse(JSON.stringify(approval))).requestedBy.kind).toBe(
      "agent",
    );
  });
});

describe("commands", () => {
  it("mints an identity and defaults the contract version and issue time", () => {
    const command = createCommand({
      name: parseCommandName("content.production.start"),
      payload: { contentId: "cnt_1" },
      source: parseTrimmedString("studio-api"),
      context: sampleContext(),
    });
    expect(String(command.id).startsWith("cmd_")).toBe(true);
    expect(command.version).toBe(CONTRACT_VERSION);
    expect(command.issuedAt).toMatch(/Z$/);
    expect(command.name).toBe("content.production.start");
    expect(command.payload).toEqual({ contentId: "cnt_1" });
  });

  it("gives every command a distinct identity", () => {
    // A command can never exist without an identity: it is what makes idempotent
    // handling and end-to-end tracing possible.
    const ids = new Set(
      Array.from(
        { length: 25 },
        () =>
          createCommand({
            name: parseCommandName("content.production.start"),
            payload: {},
            source: parseTrimmedString("studio-api"),
            context: sampleContext(),
          }).id,
      ),
    );
    expect(ids.size).toBe(25);
  });

  it("round-trips through JSON", () => {
    const command = createCommand({
      name: parseCommandName("publishing.schedule.submit"),
      payload: { channel: "youtube" },
      source: parseTrimmedString("publishing-gateway"),
      context: sampleContext(),
    });
    expect(parseCommand(JSON.parse(JSON.stringify(command)))).toEqual(command);
  });

  it("carries the execution context so the work is traceable", () => {
    const context = sampleContext();
    const command = createCommand({
      name: parseCommandName("content.production.start"),
      payload: {},
      source: parseTrimmedString("studio-api"),
      context,
    });
    expect(command.context.correlationId).toBe(context.correlationId);
    expect(command.context.tenant.tenantId).toBe(context.tenant.tenantId);
  });

  it("rejects a malformed command", () => {
    const command = createCommand({
      name: parseCommandName("content.production.start"),
      payload: {},
      source: parseTrimmedString("studio-api"),
      context: sampleContext(),
    });
    const wire = JSON.parse(JSON.stringify(command)) as Record<string, unknown>;
    for (const field of ["id", "name", "version", "issuedAt", "source", "context", "payload"]) {
      const broken = { ...wire };
      delete broken[field];
      expect(
        capture(() => parseCommand(broken)),
        field,
      ).toBeInstanceOf(ValidationError);
    }
    expect(capture(() => parseCommand({ ...wire, name: "StartProduction" }))).toBeInstanceOf(
      ValidationError,
    );
    expect(capture(() => parseCommand({ ...wire, payload: [] }))).toBeInstanceOf(ValidationError);
  });

  it("names the contract in a failure", () => {
    const thrown = capture(() => parseCommand({})) as ValidationError;
    expect(thrown.message).toContain(formatContractId(COMMAND_CONTRACT_ID, CONTRACT_VERSION));
  });
});

describe("command results", () => {
  const commandId = createCommandId();

  it("declares exactly three outcomes", () => {
    expect(COMMAND_RESULT_STATUSES).toEqual(["succeeded", "failed", "rejected"]);
  });

  it("parses a success and defaults the emitted-event list", () => {
    const result = parseCommandResult({
      status: "succeeded",
      commandId,
      completedAt: nowIso(),
      data: { contentId: "cnt_1" },
    });
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.data).toEqual({ contentId: "cnt_1" });
      expect(result.emittedEventIds).toEqual([]);
    }
  });

  it("carries the events a successful command emitted", () => {
    // Returned to the caller so the whole unit of work can be committed or dispatched
    // atomically, rather than each event being published from deep inside a handler
    // where a partial failure would leave the system inconsistent.
    const eventId = createEventId();
    const result = parseCommandResult({
      status: "succeeded",
      commandId,
      completedAt: nowIso(),
      data: {},
      emittedEventIds: [eventId],
    });
    if (result.status === "succeeded") {
      expect(result.emittedEventIds).toEqual([eventId]);
    }
  });

  it("parses a failure carrying the serialized error", () => {
    const result = parseCommandResult({
      status: "failed",
      commandId,
      completedAt: nowIso(),
      error: new ProviderError("openai", "rate limited").serialize(),
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("provider_failure");
      expect(result.error.retryable).toBe(true);
      expect(isAwaitingApproval(result)).toBe(false);
    }
  });

  it("parses a rejection with no appeal path", () => {
    const result = parseCommandResult({
      status: "rejected",
      commandId,
      completedAt: nowIso(),
      error: new PolicyViolationError("policy.publish", "refused").serialize(),
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.approval).toBeNull();
      // A refusal with no approval attached is final: retrying it is not an option the
      // caller should be offered.
      expect(isAwaitingApproval(result)).toBe(false);
    }
  });

  it("parses a rejection that is waiting on a human", () => {
    const result = parseCommandResult({
      status: "rejected",
      commandId,
      completedAt: nowIso(),
      error: new PolicyViolationError("policy.publish", "needs a signature", {
        requiresApproval: true,
      }).serialize(),
      approval: sampleApproval(),
    });
    expect(result.status).toBe("rejected");
    expect(isAwaitingApproval(result)).toBe(true);
    if (result.status === "rejected") {
      expect(result.approval?.risk).toBe("high");
    }
  });

  it("never reports a success or a failure as awaiting approval", () => {
    const succeeded: CommandResult = {
      status: "succeeded",
      commandId,
      completedAt: nowIso(),
      data: {},
      emittedEventIds: [],
    };
    const failed: CommandResult = {
      status: "failed",
      commandId,
      completedAt: nowIso(),
      error: sampleSerializedError(),
    };
    expect(isAwaitingApproval(succeeded)).toBe(false);
    expect(isAwaitingApproval(failed)).toBe(false);
  });

  it("strips a field belonging to another variant rather than adopting it", () => {
    // Consistent with the envelope's forward-compatibility rule: unknown keys are
    // ignored so a newer producer cannot break an older consumer. What matters is that
    // the caller cannot then *read* output that was never produced — a `failed` result
    // with no `data` field makes that a compile error as well as a runtime absence.
    const parsed = parseCommandResult({
      status: "failed",
      commandId,
      completedAt: nowIso(),
      error: sampleSerializedError(),
      data: { nope: true },
    });
    expect(parsed.status).toBe("failed");
    expect("data" in parsed).toBe(false);
  });

  it("rejects a result missing a field its own variant requires", () => {
    expect(
      capture(() => parseCommandResult({ status: "succeeded", commandId, completedAt: nowIso() })),
    ).toBeInstanceOf(ValidationError);
    expect(
      capture(() =>
        parseCommandResult({
          status: "rejected",
          commandId,
          completedAt: nowIso(),
          error: sampleSerializedError(),
          approval: { id: "apr_1" },
        }),
      ),
    ).toBeInstanceOf(ValidationError);
  });

  it("rejects an unknown status and a missing command identity", () => {
    expect(
      capture(() => parseCommandResult({ status: "cancelled", commandId, completedAt: nowIso() })),
    ).toBeInstanceOf(ValidationError);
    expect(
      capture(() =>
        parseCommandResult({
          status: "succeeded",
          completedAt: nowIso(),
          data: {},
        }),
      ),
    ).toBeInstanceOf(ValidationError);
  });

  it("round-trips every variant through JSON", () => {
    const variants = [
      {
        status: "succeeded",
        commandId,
        completedAt: nowIso(),
        data: { a: 1 },
        emittedEventIds: [],
      },
      { status: "failed", commandId, completedAt: nowIso(), error: sampleSerializedError() },
      {
        status: "rejected",
        commandId,
        completedAt: nowIso(),
        error: sampleSerializedError(),
        approval: sampleApproval(),
      },
    ];
    for (const variant of variants) {
      const parsed = parseCommandResult(JSON.parse(JSON.stringify(variant)));
      expect(parsed.status, variant.status).toBe(variant.status);
      expect(parsed.commandId, variant.status).toBe(commandId);
    }
  });

  it("names the contract in a failure", () => {
    const thrown = capture(() => parseCommandResult({})) as ValidationError;
    expect(thrown.message).toContain(
      formatContractId(COMMAND_RESULT_CONTRACT_ID, CONTRACT_VERSION),
    );
  });
});
