import { describe, expect, it } from "vitest";
import { ValidationError } from "@omnis/errors";
import { MAX_METADATA_ENTRIES, REDACTED_MARKER } from "./testSupport.js";
import {
  mergeMetadata,
  metadataEquals,
  metadataPath,
  metadataValue,
  sanitizeMetadata,
  withoutMetadataKeys,
} from "./ExecutionMetadata.js";

describe("sanitizeMetadata", () => {
  it("freezes the result", () => {
    const metadata = sanitizeMetadata({ channel: "web" });
    expect(metadata).toEqual({ channel: "web" });
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it("drops members that are undefined instead of rejecting the whole bag", () => {
    // Callers build metadata from optional fields constantly, and an undefined member
    // would not survive serialization anyway.
    expect(sanitizeMetadata({ keep: 1, drop: undefined })).toEqual({ keep: 1 });
  });

  it("rejects a bag that is too large", () => {
    const large: Record<string, unknown> = {};
    for (let index = 0; index < MAX_METADATA_ENTRIES + 1; index += 1) {
      large[`key${String(index)}`] = index;
    }
    expect(() => sanitizeMetadata(large)).toThrow(ValidationError);
    delete large[`key${String(MAX_METADATA_ENTRIES)}`];
    expect(() => sanitizeMetadata(large)).not.toThrow();
  });

  it("coerces values that would not survive serialization instead of failing the execution", () => {
    // Metadata is debugging data: a function attached to it is a caller mistake, not a
    // reason to abort an execution. Contract payloads are asserted instead (see
    // `createExecutionFailure`), because there a silent change of shape is a bug.
    expect(sanitizeMetadata({ handler: () => "no", ratio: Number.NaN })).toEqual({
      handler: null,
      ratio: null,
    });
    expect(sanitizeMetadata({ nested: { fn: () => 1, keep: 2 } })).toEqual({
      nested: { fn: null, keep: 2 },
    });
    expect(sanitizeMetadata({ when: new Date(0) })).toEqual({ when: "1970-01-01T00:00:00.000Z" });
  });

  it("survives a cyclic value rather than hanging or throwing", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    const sanitized = sanitizeMetadata(cyclic);
    expect(sanitized["name"]).toBe("loop");
    expect(JSON.stringify(sanitized)).toContain("loop");
  });

  it("redacts a secret-shaped value", () => {
    const metadata = sanitizeMetadata({ note: `key is ${REDACTED_MARKER.fixture}` });
    expect(String(metadata["note"])).not.toContain(REDACTED_MARKER.fixture);
  });

  it("redacts a credential held under a sensitive key", () => {
    const metadata = sanitizeMetadata({ apiKey: "not-a-secret-looking-value-but-sensitive-key" }); // omnis-secret-scan:allow a deliberate fake, used to prove this value is redacted
    expect(metadata["apiKey"]).not.toBe("not-a-secret-looking-value-but-sensitive-key");
  });
});

describe("mergeMetadata", () => {
  it("produces a new bag without mutating either input", () => {
    const base = sanitizeMetadata({ channel: "web", depth: 0 });
    const merged = mergeMetadata(base, { depth: 1 });
    expect(merged).toEqual({ channel: "web", depth: 1 });
    expect(base).toEqual({ channel: "web", depth: 0 });
    expect(merged).not.toBe(base);
  });

  it("sanitizes the patch as strictly as the base", () => {
    expect(mergeMetadata(sanitizeMetadata({ keep: 1 }), { handler: () => "no" })).toEqual({
      keep: 1,
      handler: null,
    });
    const large: Record<string, unknown> = {};
    for (let index = 0; index < MAX_METADATA_ENTRIES + 1; index += 1) {
      large[`key${String(index)}`] = index;
    }
    expect(() => mergeMetadata(sanitizeMetadata({}), large)).toThrow(ValidationError);
  });
});

describe("withoutMetadataKeys", () => {
  it("removes the named keys and keeps the rest", () => {
    const base = sanitizeMetadata({ keep: 1, drop: 2, alsoDrop: 3 });
    expect(withoutMetadataKeys(base, ["drop", "alsoDrop"])).toEqual({ keep: 1 });
    expect(base).toEqual({ keep: 1, drop: 2, alsoDrop: 3 });
  });

  it("ignores keys that are not present", () => {
    const base = sanitizeMetadata({ keep: 1 });
    expect(withoutMetadataKeys(base, ["missing"])).toEqual({ keep: 1 });
  });
});

describe("reading metadata", () => {
  it("reads a top-level value", () => {
    const base = sanitizeMetadata({ channel: "web" });
    expect(metadataValue(base, "channel")).toBe("web");
    expect(metadataValue(base, "missing")).toBeUndefined();
  });

  it("reads a nested value by dotted path", () => {
    const base = sanitizeMetadata({ request: { channel: "web", attempts: 2 } });
    expect(metadataPath(base, "request.channel")).toBe("web");
    expect(metadataPath(base, "request.missing")).toBeUndefined();
  });
});

describe("metadataEquals", () => {
  it("compares keys and JSON values", () => {
    expect(
      metadataEquals(sanitizeMetadata({ a: 1, b: "x" }), sanitizeMetadata({ b: "x", a: 1 })),
    ).toBe(true);
    expect(metadataEquals(sanitizeMetadata({ a: 1 }), sanitizeMetadata({ a: 2 }))).toBe(false);
    expect(metadataEquals(sanitizeMetadata({ a: 1 }), sanitizeMetadata({ a: 1, b: 2 }))).toBe(
      false,
    );
    expect(metadataEquals(sanitizeMetadata({}), sanitizeMetadata({}))).toBe(true);
  });

  it("compares nested structures by value", () => {
    expect(
      metadataEquals(
        sanitizeMetadata({ a: { b: [1, 2] } }),
        sanitizeMetadata({ a: { b: [1, 2] } }),
      ),
    ).toBe(true);
    expect(
      metadataEquals(
        sanitizeMetadata({ a: { b: [1, 2] } }),
        sanitizeMetadata({ a: { b: [2, 1] } }),
      ),
    ).toBe(false);
  });
});
