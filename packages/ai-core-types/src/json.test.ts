import { describe, expect, it } from "vitest";
import { ValidationError } from "@omnis/errors";
import { assertJsonSafe, findJsonSafetyIssue, hasPath, isJsonSafe, readPath } from "./json.js";

describe("findJsonSafetyIssue", () => {
  it("accepts every JSON-representable shape", () => {
    for (const value of [
      null,
      "text",
      42,
      -1.5,
      true,
      [],
      {},
      [1, "two", null, [3, { deep: true }]],
      { a: 1, b: { c: [true, null, "x"] } },
    ]) {
      expect(findJsonSafetyIssue(value).safe, JSON.stringify(value) ?? "null").toBe(true);
    }
  });

  it("reports the path of an undefined object member", () => {
    // JSON.stringify silently drops this member, so the record that comes back is not
    // the record that went in.
    const issue = findJsonSafetyIssue({ outer: { keep: 1, dropped: undefined } });
    expect(issue.safe).toBe(false);
    if (issue.safe) {
      return;
    }
    expect(issue.path).toBe("$.outer.dropped");
    expect(issue.reason).toContain("undefined");
  });

  it("reports functions and symbols as unsupported", () => {
    const withFunction = findJsonSafetyIssue({ handler: () => "no" });
    expect(withFunction.safe).toBe(false);
    if (!withFunction.safe) {
      expect(withFunction.path).toBe("$.handler");
    }

    const withSymbol = findJsonSafetyIssue([Symbol("no")]);
    expect(withSymbol.safe).toBe(false);
    if (!withSymbol.safe) {
      expect(withSymbol.path).toBe("$[0]");
    }
  });

  it("rejects non-finite numbers because JSON renders them as null", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const issue = findJsonSafetyIssue({ amount: value });
      expect(issue.safe, String(value)).toBe(false);
      if (!issue.safe) {
        expect(issue.reason).toContain("finite");
      }
    }
  });

  it("rejects structures deeper than the maximum instead of overflowing the stack", () => {
    let deep: unknown = { leaf: 1 };
    for (let level = 0; level < 40; level += 1) {
      deep = { next: deep };
    }
    const issue = findJsonSafetyIssue(deep);
    expect(issue.safe).toBe(false);
    if (!issue.safe) {
      expect(issue.reason).toContain("maximum depth");
    }
  });

  it("terminates on a cyclic structure by hitting the depth limit", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(findJsonSafetyIssue(cyclic).safe).toBe(false);
  });
});

describe("isJsonSafe", () => {
  it("agrees with findJsonSafetyIssue", () => {
    expect(isJsonSafe({ a: [1, "two", null] })).toBe(true);
    expect(isJsonSafe({ a: undefined })).toBe(false);
  });
});

describe("assertJsonSafe", () => {
  it("returns silently for a safe value", () => {
    expect(() => assertJsonSafe({ tokens: 12, model: "mdl_x" }, "metadata")).not.toThrow();
  });

  it("throws a ValidationError naming the label and the offending path", () => {
    let caught: unknown;
    try {
      assertJsonSafe({ nested: { bad: () => 1 } }, "tool metadata");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    expect(error.message).toContain("tool metadata");
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toBe("$.nested.bad");
    expect(error.issues[0]?.code).toBe("invalid_json");
    expect(error.retryable).toBe(false);
  });

  it("never echoes the offending value back", () => {
    // A value that fails a JSON-safety check may be a closure over a credential, so the
    // issue records `received: null` and the serialized error carries only the *path*.
    // The path is kept deliberately: naming the field is what makes the error
    // actionable, and it is the value, not the key, that can hold a secret.
    let caught: unknown;
    try {
      assertJsonSafe({ credentialHolder: () => "value-that-must-not-be-echoed" }, "metadata");
    } catch (error) {
      caught = error;
    }
    const error = caught as ValidationError;
    expect(error.issues[0]?.received).toBeNull();

    const serialized = JSON.stringify(error.serialize());
    expect(serialized).not.toContain("value-that-must-not-be-echoed");
    expect(serialized).toContain("$.credentialHolder");
  });
});

describe("readPath", () => {
  const source = {
    request: { channel: "web", attempts: 2 },
    items: [{ id: "first" }, { id: "second" }],
    zero: 0,
    flag: false,
  };

  it("reads nested object members", () => {
    expect(readPath(source, "request.channel")).toBe("web");
    expect(readPath(source, "request")).toEqual({ channel: "web", attempts: 2 });
  });

  it("indexes arrays by numeric segment", () => {
    expect(readPath(source, "items.1.id")).toBe("second");
    expect(readPath(source, "items.5.id")).toBeUndefined();
    expect(readPath(source, "items.-1")).toBeUndefined();
  });

  it("returns undefined for missing and non-object traversal", () => {
    expect(readPath(source, "request.missing")).toBeUndefined();
    expect(readPath(source, "missing.deep.deeper")).toBeUndefined();
    expect(readPath(source, "request.channel.deeper")).toBeUndefined();
  });

  it("returns falsy values rather than treating them as missing", () => {
    expect(readPath(source, "zero")).toBe(0);
    expect(readPath(source, "flag")).toBe(false);
    expect(hasPath(source, "zero")).toBe(true);
    expect(hasPath(source, "missing")).toBe(false);
  });

  it("returns the whole value for an empty path", () => {
    expect(readPath(source, "")).toBe(source);
  });

  it("refuses to traverse the prototype chain", () => {
    // A policy condition addressing `__proto__` must read nothing, not the inherited
    // object every record shares.
    expect(readPath(source, "__proto__")).toBeUndefined();
    expect(readPath(source, "constructor.name")).toBeUndefined();
    expect(readPath(source, "request.__proto__")).toBeUndefined();
    expect(hasPath(source, "__proto__.polluted")).toBe(false);
  });

  it("does not treat an object key that looks like an index as an array position", () => {
    expect(readPath({ "0": "keyed" }, "0")).toBe("keyed");
    expect(readPath([{ value: "array" }], "value")).toBeUndefined();
  });
});
