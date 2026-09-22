import { describe, expect, it } from "vitest";
import { AI_CORE_CONTRACT_VERSION, toolParameterSchema } from "@omnis/ai-core-types";
import { tryValidate, validate } from "@omnis/validation";
import { ValidationError } from "@omnis/errors";
import { InMemoryToolRegistry } from "./InMemoryToolRegistry.js";
import {
  isToolDenialReason,
  isToolRiskLevelValue,
  MAX_TOOL_CONCURRENCY,
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_TIMEOUT_MS,
  TOOL_AUDIT_CONTRACT,
  toolAuditRecordSchema,
  TOOL_DESCRIPTOR_CONTRACT,
  toolDenialReasonSchema,
  toolDescriptorInputSchema,
  toolDescriptorSchema,
  toolHandlerResultSchema,
  toolInvocationSchema,
  toolNameSchema,
  toolParameterSpecSchema,
  TOOL_RESULT_CONTRACT,
  toolResultSchema,
  toolVersionSchema,
} from "./toolValidation.js";
import {
  integerParam,
  stringArrayParam,
  stringParam,
  toolDescriptorInput,
  valueHandler,
} from "./testSupport.js";

describe("tool names and versions", () => {
  it("accepts the shape a model reliably emits", () => {
    for (const name of ["search", "search_documents", "s1", "x".repeat(MAX_TOOL_NAME_LENGTH)]) {
      expect(toolNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it("rejects names a model would mis-copy", () => {
    for (const name of [
      "",
      "Search",
      "search-documents",
      "search documents",
      "1search",
      "_search",
      "x".repeat(MAX_TOOL_NAME_LENGTH + 1),
    ]) {
      expect(toolNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it("accepts a semantic version and rejects a label", () => {
    for (const version of ["1.0.0", "0.1.0", "2.10.3", "1.0.0-rc.1", "1.0.0+build.5"]) {
      expect(toolVersionSchema.safeParse(version).success, version).toBe(true);
    }
    for (const version of ["1", "1.0", "v1.0.0", "latest", ""]) {
      expect(toolVersionSchema.safeParse(version).success, version).toBe(false);
    }
  });
});

describe("parameter specs", () => {
  it("accepts a recursive declaration", () => {
    const nested = {
      type: "array",
      description: "Rows.",
      enumValues: [],
      items: stringParam("A cell."),
      nullable: false,
    };
    expect(toolParameterSpecSchema.safeParse(nested).success).toBe(true);
    expect(toolParameterSpecSchema.safeParse({ ...nested, items: null }).success).toBe(true);
  });

  it("rejects an incomplete or unknown declaration", () => {
    expect(toolParameterSpecSchema.safeParse({ type: "string" }).success).toBe(false);
    expect(
      toolParameterSpecSchema.safeParse({
        type: "map",
        description: "",
        enumValues: [],
        items: null,
        nullable: false,
      }).success,
    ).toBe(false);
    expect(
      toolParameterSpecSchema.safeParse({
        type: "string",
        description: "",
        enumValues: [],
        items: null,
        nullable: "yes",
      }).success,
    ).toBe(false);
  });
});

describe("descriptor schemas", () => {
  it("accepts a registration input and fills nothing in", () => {
    const parsed = validate(toolDescriptorInputSchema, toolDescriptorInput(), "ToolDescriptor");
    expect(parsed.id).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.metadata).toBeUndefined();
    expect(parsed.timeoutMs).toBe(1_000);
  });

  it("rejects limits the runtime could not honour", () => {
    expect(
      toolDescriptorInputSchema.safeParse({ ...toolDescriptorInput(), timeoutMs: 0 }).success,
    ).toBe(false);
    expect(
      toolDescriptorInputSchema.safeParse({
        ...toolDescriptorInput(),
        timeoutMs: MAX_TOOL_TIMEOUT_MS + 1,
      }).success,
    ).toBe(false);
    expect(
      toolDescriptorInputSchema.safeParse({
        ...toolDescriptorInput(),
        maxConcurrency: MAX_TOOL_CONCURRENCY + 1,
      }).success,
    ).toBe(false);
    expect(
      toolDescriptorInputSchema.safeParse({ ...toolDescriptorInput(), sideEffect: "sometimes" })
        .success,
    ).toBe(false);
    expect(
      toolDescriptorInputSchema.safeParse({
        ...toolDescriptorInput(),
        permissions: [{ resource: "documents" }],
      }).success,
    ).toBe(false);
  });

  it("accepts a stored descriptor the registry produced", () => {
    const reg = new InMemoryToolRegistry({ clock: () => "2026-03-01T12:00:00.000Z" });
    const descriptor = reg.register(toolDescriptorInput(), valueHandler("ok"));
    expect(toolDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(toolDescriptorSchema.safeParse({ ...descriptor, status: "unknown" }).success).toBe(
      false,
    );
    expect(
      toolDescriptorSchema.safeParse({ ...descriptor, registeredAt: "yesterday" }).success,
    ).toBe(false);
  });

  it("reports a failure as a ValidationError", () => {
    expect(() =>
      validate(toolDescriptorInputSchema, { ...toolDescriptorInput(), name: "" }, "ToolDescriptor"),
    ).toThrow(ValidationError);
    expect(tryValidate(toolDescriptorInputSchema, { ...toolDescriptorInput(), name: "" }).ok).toBe(
      false,
    );
  });
});

describe("invocation, handler result and result schemas", () => {
  it("accepts an invocation and rejects one with unserializable arguments", () => {
    const invocation = {
      toolId: "tol_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "search_documents",
      arguments: { query: "x" },
      environment: {
        executionId: "exe_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        correlationId: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        attempt: 1,
      },
      metadata: {},
    };
    expect(toolInvocationSchema.safeParse(invocation).success).toBe(true);
    expect(
      toolInvocationSchema.safeParse({
        ...invocation,
        environment: { ...invocation.environment, attempt: 0 },
      }).success,
    ).toBe(false);
    expect(toolInvocationSchema.safeParse({ ...invocation, name: "Search" }).success).toBe(false);
  });

  it("accepts both handler result shapes", () => {
    expect(toolHandlerResultSchema.safeParse({ ok: true, value: { rows: [1, 2] } }).success).toBe(
      true,
    );
    expect(
      toolHandlerResultSchema.safeParse({
        ok: false,
        errorCode: "no_results",
        message: "nothing found",
      }).success,
    ).toBe(true);
    expect(toolHandlerResultSchema.safeParse({ ok: false, message: "no code" }).success).toBe(
      false,
    );
    expect(toolHandlerResultSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("accepts each normalized result variant and rejects a mixed one", () => {
    const audit = {
      executionId: "exe_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      correlationId: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolId: "tol_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolName: "search_documents",
      toolVersion: "1.0.0",
      attempt: 1,
      permissionsRequired: [],
      policyDecisionOutcome: "allow",
      startedAt: "2026-03-01T12:00:00.000Z",
      finishedAt: "2026-03-01T12:00:00.100Z",
      durationMs: 100,
      timedOut: false,
      cancelled: false,
      argumentKeys: ["query"],
    };
    expect(toolAuditRecordSchema.safeParse(audit).success).toBe(true);
    expect(toolAuditRecordSchema.safeParse({ ...audit, durationMs: -1 }).success).toBe(false);
    // An audit record carries argument *keys*. A producer that also sent values would have them
    // stripped on parse, which is the last line of defence against a record becoming a copy of
    // the most sensitive data in the system.
    const withValues = toolAuditRecordSchema.safeParse({
      ...audit,
      arguments: { query: "secret" },
    });
    expect(withValues.success).toBe(true);
    if (withValues.success) {
      expect("arguments" in withValues.data).toBe(false);
      expect(JSON.stringify(withValues.data)).not.toContain("secret");
    }

    const succeeded = {
      status: "succeeded",
      toolId: audit.toolId,
      value: "ok",
      durationMs: 10,
      audit,
    };
    const failed = {
      status: "failed",
      toolId: audit.toolId,
      errorCode: "e",
      message: "m",
      retryable: false,
      timedOut: false,
      cancelled: false,
      durationMs: 10,
      audit,
    };
    const denied = {
      status: "denied",
      toolId: audit.toolId,
      reason: "policy",
      message: "m",
      audit,
    };
    expect(toolResultSchema.safeParse(succeeded).success).toBe(true);
    expect(toolResultSchema.safeParse(failed).success).toBe(true);
    expect(toolResultSchema.safeParse(denied).success).toBe(true);
    // A denial carries no duration: nothing ran. An extra key is stripped rather than rejected,
    // which is what lets a newer producer add a field an older consumer has not seen yet.
    const stripped = toolResultSchema.safeParse({ ...denied, durationMs: 10 });
    expect(stripped.success).toBe(true);
    if (stripped.success && stripped.data.status === "denied") {
      expect("durationMs" in stripped.data).toBe(false);
    }
    expect(toolResultSchema.safeParse({ ...failed, reason: "policy" }).success).toBe(true);
    expect(toolResultSchema.safeParse({ status: "unknown" }).success).toBe(false);
  });

  it("knows the denial reasons and risk levels", () => {
    for (const reason of [
      "unregistered",
      "permission",
      "policy",
      "approval_required",
      "disabled",
      "concurrency",
    ]) {
      expect(isToolDenialReason(reason), reason).toBe(true);
      expect(toolDenialReasonSchema.safeParse(reason).success, reason).toBe(true);
    }
    expect(isToolDenialReason("rate_limited")).toBe(false);
    expect(isToolRiskLevelValue("critical")).toBe(true);
    expect(isToolRiskLevelValue("mild")).toBe(false);
  });
});

describe("contracts", () => {
  it("publishes each contract at the AI Core version", () => {
    expect(TOOL_DESCRIPTOR_CONTRACT.contractId).toBe("ToolDescriptor");
    expect(TOOL_RESULT_CONTRACT.contractId).toBe("ToolResult");
    expect(TOOL_AUDIT_CONTRACT.contractId).toBe("ToolAuditRecord");
    for (const contract of [TOOL_DESCRIPTOR_CONTRACT, TOOL_RESULT_CONTRACT, TOOL_AUDIT_CONTRACT]) {
      expect(contract.version).toBe(AI_CORE_CONTRACT_VERSION);
    }
  });

  it("validates through the contract's schema", () => {
    expect(TOOL_DESCRIPTOR_CONTRACT.schema.safeParse(toolDescriptorInput()).success).toBe(false);
    expect(TOOL_DESCRIPTOR_CONTRACT.schema.safeParse({}).success).toBe(false);
  });
});

describe("parameter schema helpers used by fixtures", () => {
  it("builds the closed schemas the fixtures declare", () => {
    const schema = toolParameterSchema(
      { query: stringParam(), tags: stringArrayParam(), limit: integerParam() },
      ["query"],
    );
    expect(Object.keys(schema.properties)).toEqual(["query", "tags", "limit"]);
    expect(schema.required).toEqual(["query"]);
    expect(Object.isFrozen(schema)).toBe(true);
  });
});
