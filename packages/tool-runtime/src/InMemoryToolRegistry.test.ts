import { describe, expect, it } from "vitest";
import { createToolId } from "@omnis/types";
import {
  EMPTY_TOOL_PARAMETER_SCHEMA,
  formatPermission,
  toolParameterSchema,
} from "@omnis/ai-core-types";
import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import { InMemoryToolRegistry } from "./InMemoryToolRegistry.js";
import { isLegalToolStatusTransition, TOOL_STATUS_TRANSITIONS } from "./ToolRegistry.js";
import { integerParam, stringParam, toolDescriptorInput, valueHandler } from "./testSupport.js";

const AT = "2026-03-01T12:00:00.000Z";

function registry(maxEntries = 256): InMemoryToolRegistry {
  return new InMemoryToolRegistry({ clock: () => AT, maxEntries });
}

/** Registers a tool and returns its descriptor and handler. */
function registered(
  reg: InMemoryToolRegistry,
  overrides: Partial<Parameters<typeof toolDescriptorInput>[0]> = {},
) {
  const handler = valueHandler("ok");
  const descriptor = reg.register(toolDescriptorInput({ registeredAt: AT, ...overrides }), handler);
  return { descriptor, handler };
}

describe("registration", () => {
  it("stores a frozen, enabled descriptor", () => {
    const reg = registry();
    const { descriptor } = registered(reg);
    expect(descriptor.id.startsWith("tol_")).toBe(true);
    expect(descriptor.name).toBe("search_documents");
    expect(descriptor.status).toBe("enabled");
    expect(descriptor.registeredAt).toBe(AT);
    expect(descriptor.policyId).toBeNull();
    expect(descriptor.budgetId).toBeNull();
    expect(descriptor.metadata).toEqual({});
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.parameters)).toBe(true);
    expect(Object.isFrozen(descriptor.parameters.properties)).toBe(true);
    expect(Object.isFrozen(descriptor.permissions)).toBe(true);
    expect(Object.isFrozen(descriptor.metadata)).toBe(true);
    expect(reg.size).toBe(1);
  });

  it("keeps a caller-supplied identifier and status", () => {
    const reg = registry();
    const toolId = createToolId();
    const descriptor = reg.register(
      toolDescriptorInput({ id: toolId, status: "deprecated", registeredAt: AT }),
      valueHandler("ok"),
    );
    expect(descriptor.id).toBe(toolId);
    expect(descriptor.status).toBe("deprecated");
  });

  it("rejects a duplicate name and a duplicate identifier", () => {
    const reg = registry();
    const first = registered(reg);
    expect(() => registered(reg)).toThrow(ConflictError);
    expect(() =>
      reg.register(
        toolDescriptorInput({ id: first.descriptor.id, name: "other_tool", registeredAt: AT }),
        valueHandler("ok"),
      ),
    ).toThrow(ConflictError);
    expect(reg.size).toBe(1);
  });

  it("enforces capacity", () => {
    const reg = registry(1);
    registered(reg);
    expect(() => registered(reg, { name: "second_tool" })).toThrow(ConflictError);
    expect(() => registry(0)).toThrow(RangeError);
  });

  it("verifies the handler at registration, not at first call", () => {
    const reg = registry();
    expect(() =>
      reg.register(toolDescriptorInput({ registeredAt: AT }), undefined as never),
    ).toThrow(ValidationError);
    expect(() => reg.register(toolDescriptorInput({ registeredAt: AT }), {} as never)).toThrow(
      ValidationError,
    );
    // A two-parameter handler would be called with one and silently receive undefined.
    const twoParameters = (_invocation: unknown, _extra: unknown) => ({
      ok: true as const,
      value: null,
    });
    expect(() =>
      reg.register(toolDescriptorInput({ registeredAt: AT }), twoParameters as never),
    ).toThrow(ValidationError);
    expect(reg.size).toBe(0);
    // A parameterless handler is fine: it simply ignores the invocation.
    expect(() =>
      reg.register(toolDescriptorInput({ registeredAt: AT }), () => ({ ok: true, value: 1 })),
    ).not.toThrow();
  });

  it("rejects a descriptor a model could not be given", () => {
    const reg = registry();
    expect(() => registered(reg, { name: "SearchDocuments" })).toThrow(ValidationError);
    expect(() => registered(reg, { name: "" })).toThrow(ValidationError);
    expect(() => registered(reg, { version: "v1" })).toThrow(ValidationError);
    expect(() => registered(reg, { description: "" })).toThrow(ValidationError);
    expect(() => registered(reg, { timeoutMs: 0 })).toThrow(ValidationError);
    expect(() => registered(reg, { timeoutMs: 1.5 })).toThrow(ValidationError);
    expect(() => registered(reg, { maxConcurrency: 0 })).toThrow(ValidationError);
    expect(() => registered(reg, { riskLevel: "extreme" as never })).toThrow(ValidationError);
    expect(() => registered(reg, { kind: "delete" as never })).toThrow(ValidationError);
    expect(reg.size).toBe(0);
  });

  it("rebuilds the parameter schema so the stored one is closed and frozen", () => {
    const reg = registry();
    const { descriptor } = registered(reg, {
      parameters: toolParameterSchema({ query: stringParam() }, ["query"]),
    });
    expect(descriptor.parameters.kind).toBe("object");
    expect(Object.isFrozen(descriptor.parameters.properties["query"])).toBe(true);
    expect(() =>
      registered(reg, { name: "no_params", parameters: EMPTY_TOOL_PARAMETER_SCHEMA }),
    ).not.toThrow();
    // A required key that is not declared is rejected by the schema builder itself.
    expect(() => toolParameterSchema({ a: integerParam() }, ["b"])).toThrow(RangeError);
  });

  it("rejects a permission that cannot be parsed back", () => {
    const reg = registry();
    expect(() =>
      registered(reg, { permissions: [{ resource: "documents", action: "read" }] }),
    ).not.toThrow();
    expect(() =>
      registered(reg, { name: "bad_perm", permissions: [{ resource: "", action: "read" }] }),
    ).toThrow(ValidationError);
  });

  it("redacts secret-looking metadata", () => {
    const reg = registry();
    const { descriptor } = registered(reg, {
      metadata: { apiKey: "AIza" + "A".repeat(35), owner: "search-team" },
    });
    expect(String(descriptor.metadata["apiKey"])).not.toContain("AIza");
    expect(descriptor.metadata["owner"]).toBe("search-team");
  });
});

describe("lookup", () => {
  it("finds by identifier and by name, and reports absence", () => {
    const reg = registry();
    const { descriptor, handler } = registered(reg);
    expect(reg.get(descriptor.id)).toBe(descriptor);
    expect(reg.require(descriptor.id)).toBe(descriptor);
    expect(reg.has(descriptor.id)).toBe(true);
    expect(reg.getByName("search_documents")).toBe(descriptor);
    expect(reg.hasName("search_documents")).toBe(true);
    expect(reg.idForName("search_documents")).toBe(descriptor.id);
    expect(reg.resolve({ kind: "id", toolId: descriptor.id })).toBe(descriptor);
    expect(reg.resolve({ kind: "name", name: "search_documents" })).toBe(descriptor);
    expect(reg.handlerFor(descriptor.id)).toBe(handler);
    expect(reg.requireHandler(descriptor.id)).toBe(handler);

    const missing = createToolId();
    expect(reg.get(missing)).toBeNull();
    expect(reg.has(missing)).toBe(false);
    expect(reg.getByName("nope")).toBeNull();
    expect(reg.idForName("nope")).toBeNull();
    expect(reg.resolve({ kind: "name", name: "nope" })).toBeNull();
    expect(reg.handlerFor(missing)).toBeNull();
    expect(() => reg.require(missing)).toThrow(NotFoundError);
    expect(() => reg.requireHandler(missing)).toThrow(NotFoundError);
  });

  it("never exposes a handler through the descriptor", () => {
    const reg = registry();
    const { descriptor } = registered(reg);
    expect(JSON.stringify(descriptor)).not.toContain("ok");
    expect(Object.keys(descriptor)).not.toContain("handler");
  });

  it("lists by name and filters by kind, risk and permission resource", () => {
    const reg = registry();
    registered(reg, {
      name: "write_document",
      kind: "write",
      riskLevel: "high",
      permissions: [{ resource: "documents", action: "write" }],
    });
    registered(reg, {
      name: "delete_document",
      kind: "write",
      riskLevel: "critical",
      permissions: [{ resource: "documents", action: "admin" }],
    });
    const reader = registered(reg, {
      name: "read_document",
      kind: "read",
      riskLevel: "low",
      permissions: [{ resource: "documents", action: "read" }],
    });

    expect(reg.list().map((candidate) => candidate.name)).toEqual([
      "delete_document",
      "read_document",
      "write_document",
    ]);
    expect(reg.findByKind("write").map((candidate) => candidate.name)).toEqual([
      "delete_document",
      "write_document",
    ]);
    expect(reg.findByRiskLevel("high").map((candidate) => candidate.name)).toEqual([
      "delete_document",
      "write_document",
    ]);
    expect(reg.findByRiskLevel("critical").map((candidate) => candidate.name)).toEqual([
      "delete_document",
    ]);
    expect(reg.findByPermissionResource("documents")).toHaveLength(3);
    expect(reg.findByPermissionResource("nowhere")).toEqual([]);
    expect(reader.descriptor.permissions.map(formatPermission)).toEqual(["documents:read"]);
    expect(Object.isFrozen(reg.list())).toBe(true);
  });

  it("lists only invocable tools", () => {
    const reg = registry();
    const enabled = registered(reg, { name: "aaa_enabled" });
    const deprecated = registered(reg, { name: "bbb_deprecated", status: "deprecated" });
    registered(reg, { name: "ccc_disabled", status: "disabled" });
    expect(reg.invocable().map((candidate) => candidate.name)).toEqual([
      "aaa_enabled",
      "bbb_deprecated",
    ]);
    reg.setStatus(enabled.descriptor.id, "disabled");
    expect(reg.invocable().map((candidate) => candidate.name)).toEqual(["bbb_deprecated"]);
    expect(deprecated.descriptor.status).toBe("deprecated");
  });
});

describe("lifecycle", () => {
  it("moves a tool through the published transitions", () => {
    const reg = registry();
    const { descriptor } = registered(reg);
    expect(reg.setStatus(descriptor.id, "deprecated").status).toBe("deprecated");
    expect(reg.setStatus(descriptor.id, "disabled").status).toBe("disabled");
    expect(reg.setStatus(descriptor.id, "enabled").status).toBe("enabled");
    // A no-op transition returns the identical descriptor.
    const enabled = reg.require(descriptor.id);
    expect(reg.setStatus(descriptor.id, "enabled")).toBe(enabled);
  });

  it("keeps the handler across a status change", () => {
    const reg = registry();
    const { descriptor, handler } = registered(reg);
    reg.setStatus(descriptor.id, "disabled");
    expect(reg.requireHandler(descriptor.id)).toBe(handler);
  });

  it("agrees with the transition table", () => {
    for (const from of Object.keys(
      TOOL_STATUS_TRANSITIONS,
    ) as (keyof typeof TOOL_STATUS_TRANSITIONS)[]) {
      expect(isLegalToolStatusTransition(from, from)).toBe(true);
      for (const to of TOOL_STATUS_TRANSITIONS[from] ?? []) {
        expect(isLegalToolStatusTransition(from, to), `${from}->${to}`).toBe(true);
      }
    }
    expect(() => registry().setStatus(createToolId(), "disabled")).toThrow(NotFoundError);
  });
});

describe("removal", () => {
  it("frees the name and refuses an unknown identifier", () => {
    const reg = registry();
    const { descriptor } = registered(reg);
    expect(reg.remove(descriptor.id)).toBe(true);
    expect(reg.remove(descriptor.id)).toBe(false);
    expect(reg.hasName("search_documents")).toBe(false);
    expect(reg.size).toBe(0);
  });

  it("lets a freed name be registered to a new tool with a new identifier", () => {
    const reg = registry();
    const first = registered(reg);
    reg.remove(first.descriptor.id);
    const second = registered(reg);
    expect(second.descriptor.id).not.toBe(first.descriptor.id);
    expect(second.descriptor.name).toBe(first.descriptor.name);
  });
});
