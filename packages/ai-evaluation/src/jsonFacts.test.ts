import { describe, expect, it } from "vitest";
import {
  jsonEquals,
  kindOfJson,
  leafPaths,
  MAX_COMPARED_PATHS,
  MAX_RENDERED_CHARACTERS,
  readJsonPath,
  renderedLength,
  stableJson,
} from "./jsonFacts.js";

describe("kindOfJson", () => {
  it("labels every JSON kind", () => {
    expect(kindOfJson(null)).toBe("null");
    expect(kindOfJson(undefined)).toBe("null");
    expect(kindOfJson(true)).toBe("boolean");
    expect(kindOfJson(1)).toBe("number");
    expect(kindOfJson("a")).toBe("string");
    expect(kindOfJson([])).toBe("array");
    expect(kindOfJson({})).toBe("object");
  });
});

describe("stableJson", () => {
  it("renders object keys in sorted order", () => {
    // Insertion order must not change the rendering, or the same answer evaluated in two processes
    // would produce two different findings.
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableJson([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
    expect(stableJson(null)).toBe("null");
    expect(stableJson("text")).toBe('"text"');
  });

  it("truncates an enormous output instead of copying it", () => {
    const huge = "x".repeat(MAX_RENDERED_CHARACTERS + 500);
    expect(stableJson(huge).length).toBe(MAX_RENDERED_CHARACTERS + 1);
    expect(stableJson(huge).endsWith("…")).toBe(true);
  });
});

describe("renderedLength", () => {
  it("measures a string as itself and anything else as its rendering", () => {
    expect(renderedLength("hello")).toBe(5);
    expect(renderedLength(null)).toBe(0);
    expect(renderedLength(undefined)).toBe(0);
    expect(renderedLength(42)).toBe(2);
    expect(renderedLength({ a: 1 })).toBe('{"a":1}'.length);
  });
});

describe("jsonEquals", () => {
  it("compares structurally, ignoring key order", () => {
    expect(jsonEquals({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals(null, null)).toBe(true);
    expect(jsonEquals(null, {})).toBe(false);
    expect(jsonEquals({}, null)).toBe(false);
    expect(jsonEquals(undefined, null)).toBe(false);
    expect(jsonEquals(1, "1")).toBe(false);
    expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEquals({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true);
    expect(jsonEquals({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
    expect(jsonEquals([1, [2, 3]], [1, [2, 3]])).toBe(true);
  });
});

describe("leafPaths", () => {
  it("walks objects and arrays in a deterministic order", () => {
    expect(leafPaths({ b: 1, a: { c: 2, d: [3, 4] } })).toEqual(["a.c", "a.d.0", "a.d.1", "b"]);
    expect(leafPaths("scalar")).toEqual([""]);
    expect(leafPaths(null)).toEqual([""]);
    expect(leafPaths({})).toEqual([]);
  });

  it("caps the walk so a deep output cannot stall an evaluation", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < MAX_COMPARED_PATHS + 100; index += 1) {
      wide[`key${String(index)}`] = index;
    }
    expect(leafPaths(wide)).toHaveLength(MAX_COMPARED_PATHS);
    expect(leafPaths(wide, 4)).toHaveLength(4);
    expect(Object.isFrozen(leafPaths(wide, 4))).toBe(true);
  });
});

describe("readJsonPath", () => {
  it("reads dotted paths through objects and arrays", () => {
    const value = { a: { b: [10, { c: "deep" }] } };
    expect(readJsonPath(value, "")).toBe(value);
    expect(readJsonPath(value, "a.b.0")).toBe(10);
    expect(readJsonPath(value, "a.b.1.c")).toBe("deep");
    expect(readJsonPath(value, "a.missing")).toBeUndefined();
    expect(readJsonPath(value, "a.b.0.c")).toBeUndefined();
    expect(readJsonPath(null, "a")).toBeUndefined();
  });
});
