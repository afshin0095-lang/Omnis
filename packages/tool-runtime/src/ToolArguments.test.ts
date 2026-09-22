import { describe, expect, it } from "vitest";
import { toolParameterSchema } from "@omnis/ai-core-types";
import type { ValidationError } from "@omnis/errors";
import {
  argumentKeys,
  argumentsSatisfy,
  assertToolArguments,
  describeArgumentProblems,
  validateToolArguments,
} from "./ToolArguments.js";
import { integerParam, stringArrayParam, stringParam } from "./testSupport.js";

const SCHEMA = toolParameterSchema(
  {
    query: stringParam("The query text."),
    limit: integerParam("Maximum results.", true),
    mode: stringParam("The search mode.", ["exact", "fuzzy"]),
    tags: stringArrayParam("Tags to filter on."),
    options: {
      type: "object",
      description: "Opaque options.",
      enumValues: [],
      items: null,
      nullable: false,
    },
  },
  ["query"],
);

describe("validateToolArguments", () => {
  it("accepts a well-formed argument bag", () => {
    expect(
      validateToolArguments(SCHEMA, {
        query: "report",
        limit: 10,
        mode: "exact",
        tags: ["a"],
        options: { nested: true },
      }),
    ).toEqual([]);
    expect(argumentsSatisfy(SCHEMA, { query: "report" })).toBe(true);
  });

  it("accepts a null for a nullable parameter and refuses one for the rest", () => {
    expect(argumentsSatisfy(SCHEMA, { query: "report", limit: null })).toBe(true);
    const problems = validateToolArguments(SCHEMA, { query: null });
    expect(problems.map((problem) => problem.code)).toContain("null");
  });

  it("reports a missing required argument", () => {
    const problems = validateToolArguments(SCHEMA, { limit: 5 });
    expect(problems).toEqual([{ path: "query", code: "missing", message: "query is required" }]);
  });

  it("reports every problem, not just the first", () => {
    const problems = validateToolArguments(SCHEMA, { limit: "ten", mode: "sideways", extra: 1 });
    // Missing required arguments are reported first, then declared-key problems, then unknown
    // keys: the order a caller should read them in.
    expect(problems.map((problem) => problem.code)).toEqual(["missing", "type", "enum", "unknown"]);
    expect(problems.map((problem) => problem.path)).toEqual(["query", "limit", "mode", "extra"]);
  });

  it("rejects an argument the tool did not declare", () => {
    // A closed schema is what makes permission checking meaningful: a tool that accepted an
    // undeclared flag could not have been reasoned about when it was registered.
    const problems = validateToolArguments(SCHEMA, { query: "x", adminOverride: true });
    expect(problems).toEqual([
      {
        path: "adminOverride",
        code: "unknown",
        message: "adminOverride is not a declared argument of this tool",
      },
    ]);
  });

  it("checks types", () => {
    expect(validateToolArguments(SCHEMA, { query: 1 })[0]?.message).toContain("must be a string");
    expect(validateToolArguments(SCHEMA, { query: "x", limit: 1.5 })[0]?.code).toBe("type");
    expect(validateToolArguments(SCHEMA, { query: "x", limit: Number.NaN })[0]?.code).toBe("type");
    expect(validateToolArguments(SCHEMA, { query: "x", tags: "a" })[0]?.message).toContain(
      "must be an array",
    );
    expect(validateToolArguments(SCHEMA, { query: "x", options: [] })[0]?.message).toContain(
      "must be an object",
    );
    expect(argumentsSatisfy(SCHEMA, { query: "x", options: null })).toBe(false);
  });

  it("validates array elements and names the offending index", () => {
    const problems = validateToolArguments(SCHEMA, { query: "x", tags: ["a", 2, "c"] });
    expect(problems.map((problem) => problem.path)).toEqual(["tags.1"]);
  });

  it("accepts an empty array and an array parameter with no element declaration", () => {
    expect(argumentsSatisfy(SCHEMA, { query: "x", tags: [] })).toBe(true);
    const loose = toolParameterSchema(
      {
        items: {
          type: "array",
          description: "Anything.",
          enumValues: [],
          items: null,
          nullable: false,
        },
      },
      [],
    );
    expect(argumentsSatisfy(loose, { items: [1, "a", null] })).toBe(true);
  });

  it("enforces enum values", () => {
    expect(argumentsSatisfy(SCHEMA, { query: "x", mode: "fuzzy" })).toBe(true);
    expect(validateToolArguments(SCHEMA, { query: "x", mode: "Fuzzy" })[0]?.code).toBe("enum");
  });

  it("returns a frozen list in a deterministic order", () => {
    const problems = validateToolArguments(SCHEMA, { zebra: 1, apple: 2, query: "x" });
    expect(problems.map((problem) => problem.path)).toEqual(["apple", "zebra"]);
    expect(Object.isFrozen(problems)).toBe(true);
  });
});

describe("assertToolArguments", () => {
  it("passes a valid bag and throws once for an invalid one", () => {
    expect(() => assertToolArguments("search_documents", SCHEMA, { query: "x" })).not.toThrow();
    try {
      assertToolArguments("search_documents", SCHEMA, { limit: "ten", extra: 1 });
      expect.unreachable("invalid arguments must throw");
    } catch (error) {
      const validation = error as ValidationError;
      expect(validation.code).toBe("validation_failed");
      expect(validation.message).toContain("query is required");
      expect(validation.message).toContain("extra is not a declared argument");
      // The message names the problems; it never echoes the values.
      expect(validation.message).not.toContain("ten");
    }
  });
});

describe("argumentKeys", () => {
  it("returns sorted keys and never values", () => {
    const keys = argumentKeys({ query: "secret text", limit: 5, token: "AIza" + "A".repeat(35) });
    expect(keys).toEqual(["limit", "query", "token"]);
    expect(JSON.stringify(keys)).not.toContain("secret");
    expect(Object.isFrozen(keys)).toBe(true);
  });

  it("is empty for a parameterless call", () => {
    expect(argumentKeys({})).toEqual([]);
  });
});

describe("describeArgumentProblems", () => {
  it("renders every problem on one line", () => {
    expect(describeArgumentProblems(validateToolArguments(SCHEMA, {}))).toBe("query is required");
    expect(describeArgumentProblems([])).toBe("");
  });
});
