import { describe, expect, it } from "vitest";
import { createToolId } from "@omnis/types";
import {
  EMPTY_TOOL_PARAMETER_SCHEMA,
  formatPermission,
  isAtLeastRisk,
  isInvocableToolStatus,
  isRetryableSideEffect,
  isToolReference,
  parsePermission,
  TOOL_PERMISSION_ACTIONS,
  toolById,
  toolByName,
  toolParameterSchema,
  type ToolParameterSpec,
} from "./index.js";

const stringSpec: ToolParameterSpec = {
  type: "string",
  description: "a query",
  enumValues: [],
  items: null,
  nullable: false,
};

describe("tool parameter schemas", () => {
  it("freezes a closed schema", () => {
    const schema = toolParameterSchema({ query: stringSpec }, ["query"]);
    expect(schema.kind).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(["query"]);
    expect(schema.required).toEqual(["query"]);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.properties)).toBe(true);
  });

  it("rejects a required parameter that was never declared", () => {
    // A required key with no declaration could never be validated, so the call would
    // fail at runtime with a confusing "missing property" instead of at registration.
    expect(() => toolParameterSchema({ query: stringSpec }, ["missing"])).toThrow(RangeError);
  });

  it("provides a parameterless schema for tools that take no arguments", () => {
    expect(EMPTY_TOOL_PARAMETER_SCHEMA.properties).toEqual({});
    expect(EMPTY_TOOL_PARAMETER_SCHEMA.required).toEqual([]);
  });
});

describe("permissions", () => {
  it("round-trips resource and action", () => {
    for (const action of TOOL_PERMISSION_ACTIONS) {
      const permission = { resource: "network", action };
      const formatted = formatPermission(permission);
      expect(formatted).toBe(`network:${action}`);
      expect(parsePermission(formatted)).toEqual(permission);
    }
  });

  it("splits on the last colon so a resource may contain colons", () => {
    expect(parsePermission("fs:/var/data:read")).toEqual({
      resource: "fs:/var/data",
      action: "read",
    });
  });

  it("rejects malformed permissions instead of guessing", () => {
    for (const value of ["", ":", "read", "network:", ":read", "network:destroy", "network:READ"]) {
      expect(parsePermission(value), value).toBeNull();
    }
  });
});

describe("risk ordering", () => {
  it("is monotonic across the four levels", () => {
    expect(isAtLeastRisk("critical", "low")).toBe(true);
    expect(isAtLeastRisk("high", "high")).toBe(true);
    expect(isAtLeastRisk("medium", "high")).toBe(false);
    expect(isAtLeastRisk("low", "low")).toBe(true);
  });
});

describe("side effects", () => {
  it("allows a retry only when repeating the call is safe", () => {
    expect(isRetryableSideEffect("none")).toBe(true);
    expect(isRetryableSideEffect("idempotent_write")).toBe(true);
    // A failed non-idempotent write may already have landed; retrying duplicates it.
    expect(isRetryableSideEffect("non_idempotent_write")).toBe(false);
    expect(isRetryableSideEffect("external_side_effect")).toBe(false);
  });
});

describe("tool status", () => {
  it("keeps deprecated tools invocable but disables disabled ones", () => {
    expect(isInvocableToolStatus("enabled")).toBe(true);
    // Deprecated means "still works, stop building on it" — refusing to run it would
    // break every agent that has not migrated yet.
    expect(isInvocableToolStatus("deprecated")).toBe(true);
    expect(isInvocableToolStatus("disabled")).toBe(false);
  });
});

describe("tool identifiers", () => {
  it("are branded with the tool prefix", () => {
    expect(createToolId()).toMatch(/^tol_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("isToolReference", () => {
  it("accepts both variants the builders produce", () => {
    expect(isToolReference(toolById(createToolId()))).toBe(true);
    expect(isToolReference(toolByName("search_documents"))).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isToolReference("search_documents")).toBe(false);
    expect(isToolReference(null)).toBe(false);
    expect(isToolReference({ kind: "id" })).toBe(false);
    expect(isToolReference({ kind: "id", toolId: "" })).toBe(false);
    expect(isToolReference({ kind: "name", name: "" })).toBe(false);
    expect(isToolReference({ kind: "slug", slug: "x" })).toBe(false);
  });
});
