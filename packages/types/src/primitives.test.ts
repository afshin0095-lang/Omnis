/**
 * Branded primitive tests.
 *
 * Every one of these types exists to make an illegal state unrepresentable: a
 * `Percentage` cannot be 140, a `UtcTimestamp` cannot carry a timezone offset, an
 * `EmailAddress` cannot reach a log line. The tests therefore spend most of their
 * effort on the rejections — an over-permissive parser is indistinguishable from no
 * parser at all once the value is branded.
 */

import { describe, expect, it } from "vitest";
import {
  compareSemVer,
  InvalidValueError,
  isJsonValue,
  isParseFailure,
  isParseSuccess,
  nowIso,
  OmnisTypeError,
  parseEmailAddress,
  parseIsoDateTime,
  parseLanguageTag,
  parseNonEmptyString,
  parsePercentage,
  parseRatio,
  parseSemVer,
  parseTrimmedString,
  parseUri,
  semVerParts,
  toIso,
  tryParseEmailAddress,
  tryParseIsoDateTime,
  tryParseLanguageTag,
  tryParseNonEmptyString,
  tryParsePercentage,
  tryParseRatio,
  tryParseSemVer,
  tryParseTrimmedString,
  tryParseUri,
  unwrapParseResult,
} from "./index.js";

describe("trimmed and non-empty strings", () => {
  it("trims and accepts surrounding whitespace", () => {
    expect(tryParseTrimmedString("  OMNIS  ")).toEqual({ ok: true, value: "OMNIS" });
    expect(parseTrimmedString("\n\tOMNIS\n")).toBe("OMNIS");
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(tryParseTrimmedString("").ok).toBe(false);
    expect(tryParseTrimmedString("   ").ok).toBe(false);
    expect(tryParseNonEmptyString("\t\n ").ok).toBe(false);
  });

  it("rejects non-strings rather than coercing them", () => {
    // `String(0)` would turn a missing field into the identifier "0".
    expect(tryParseTrimmedString(0).ok).toBe(false);
    expect(tryParseTrimmedString(null).ok).toBe(false);
    expect(tryParseTrimmedString(undefined).ok).toBe(false);
    expect(tryParseTrimmedString(["a"]).ok).toBe(false);
  });

  it("keeps interior whitespace in a non-empty string but not in a trimmed one", () => {
    expect(parseNonEmptyString("  two  words  ")).toBe("  two  words  ");
    expect(parseTrimmedString("  two  words  ")).toBe("two  words");
  });

  it("includes the caller's label in the thrown message", () => {
    let thrown: unknown;
    try {
      parseTrimmedString("", "character.name");
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as InvalidValueError;
    expect(failure).toBeInstanceOf(InvalidValueError);
    expect(failure.type).toBe("TrimmedString");
    expect(failure.message).toContain("character.name");
    expect(failure.code).toBe("invalid_value");
  });
});

describe("UTC timestamps", () => {
  it("accepts millisecond-precision UTC instants", () => {
    expect(tryParseIsoDateTime("2026-09-11T12:00:00.000Z").ok).toBe(true);
    expect(tryParseIsoDateTime("2026-09-11T12:00:00Z").ok).toBe(true);
    expect(tryParseIsoDateTime("2026-09-11T12:00:00.123456789Z").ok).toBe(true);
  });

  it("rejects anything that is not UTC", () => {
    // Cross-timezone scheduling is the reason for the restriction: an offset-bearing
    // timestamp makes ordering and retention windows ambiguous.
    expect(tryParseIsoDateTime("2026-09-11T12:00:00+03:30").ok).toBe(false);
    expect(tryParseIsoDateTime("2026-09-11T12:00:00").ok).toBe(false);
    expect(tryParseIsoDateTime("2026-09-11 12:00:00Z").ok).toBe(false);
    expect(tryParseIsoDateTime("11 September 2026").ok).toBe(false);
  });

  it("rejects a syntactically valid but impossible instant", () => {
    expect(tryParseIsoDateTime("2026-02-31T00:00:00.000Z").ok).toBe(false);
    expect(tryParseIsoDateTime("2026-13-01T00:00:00.000Z").ok).toBe(false);
  });

  it("produces UTC timestamps from the clock and from a Date", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(toIso(new Date("2026-09-11T12:00:00.000Z"))).toBe("2026-09-11T12:00:00.000Z");
  });

  it("throws InvalidValueError echoing the rejected value", () => {
    expect(() => parseIsoDateTime("yesterday")).toThrow(InvalidValueError);
    let thrown: unknown;
    try {
      parseIsoDateTime("yesterday");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as InvalidValueError).message).toContain("yesterday");
  });
});

describe("URIs", () => {
  it("accepts absolute URIs and normalises them", () => {
    const result = tryParseUri("HTTPS://Example.COM/Path");
    expect(result.ok).toBe(true);
    // `new URL().toString()` lowercases the scheme and host; asserting that keeps the
    // normalisation from silently changing if the implementation is rewritten.
    if (result.ok) {
      expect(result.value).toBe("https://example.com/Path");
    }
    expect(tryParseUri("https://omnis.ai").ok).toBe(true);
  });

  it("rejects relative references and empty input", () => {
    expect(tryParseUri("/path/only").ok).toBe(false);
    expect(tryParseUri("").ok).toBe(false);
    expect(tryParseUri("omnis.ai").ok).toBe(false);
    expect(tryParseUri("x".repeat(2049)).ok).toBe(false);
  });

  it("throws with the rejected value in the message", () => {
    expect(() => parseUri("nope")).toThrow(InvalidValueError);
  });
});

describe("email addresses", () => {
  it("accepts and lowercases a valid address", () => {
    expect(tryParseEmailAddress("  Ops@OMNIS.AI ")).toEqual({ ok: true, value: "ops@omnis.ai" });
    expect(parseEmailAddress("first.last+tag@sub.example.co.uk")).toBe(
      "first.last+tag@sub.example.co.uk",
    );
  });

  it("rejects malformed addresses", () => {
    for (const invalid of ["", "no-at-sign", "@no-local.com", "no-domain@", "a@b", "a b@c.com"]) {
      expect(tryParseEmailAddress(invalid).ok, invalid).toBe(false);
    }
  });

  it("never echoes the rejected address", () => {
    // An email address is personal data. It has no business appearing in a log line,
    // an error payload or a trace attribute.
    let thrown: unknown;
    try {
      parseEmailAddress("not-an-email");
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as InvalidValueError;
    expect(failure.message).not.toContain("not-an-email");
    expect(failure.message).toContain("EmailAddress");
  });
});

describe("bounded numbers", () => {
  it("accepts the closed intervals", () => {
    expect(parsePercentage(0)).toBe(0);
    expect(parsePercentage(100)).toBe(100);
    expect(parsePercentage(42.5)).toBe(42.5);
    expect(parseRatio(0)).toBe(0);
    expect(parseRatio(1)).toBe(1);
  });

  it("rejects out-of-range values", () => {
    expect(tryParsePercentage(-0.001).ok).toBe(false);
    expect(tryParsePercentage(100.001).ok).toBe(false);
    expect(tryParseRatio(1.5).ok).toBe(false);
    expect(tryParseRatio(-1).ok).toBe(false);
  });

  it("rejects the numbers that JSON cannot carry", () => {
    // A confidence score of NaN would serialise to null and read back as "no signal"
    // rather than as a failure, which is worse than refusing the value.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(tryParseRatio(value).ok, String(value)).toBe(false);
      expect(tryParsePercentage(value).ok, String(value)).toBe(false);
    }
  });

  it("rejects non-numbers rather than coercing them", () => {
    expect(tryParsePercentage("50").ok).toBe(false);
    expect(tryParseRatio(null).ok).toBe(false);
    expect(() => parsePercentage(undefined)).toThrow(InvalidValueError);
  });
});

describe("semantic versions", () => {
  it("accepts release and pre-release versions", () => {
    expect(parseSemVer("1.0.0")).toBe("1.0.0");
    expect(parseSemVer("0.1.0")).toBe("0.1.0");
    expect(parseSemVer("10.20.30-rc.1")).toBe("10.20.30-rc.1");
  });

  it("rejects zero-padded components and incomplete versions", () => {
    for (const invalid of ["1.0", "1", "01.0.0", "1.0.0.0", "v1.0.0", "1.0.0+", "", "latest"]) {
      expect(tryParseSemVer(invalid).ok, invalid).toBe(false);
    }
  });

  it("splits a version into its components", () => {
    expect(semVerParts(parseSemVer("2.11.3"))).toEqual({
      major: 2,
      minor: 11,
      patch: 3,
      prerelease: null,
    });
    expect(semVerParts(parseSemVer("1.0.0-rc.2"))).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: "rc.2",
    });
  });

  it("orders versions by major, then minor, then patch", () => {
    expect(compareSemVer(parseSemVer("1.0.0"), parseSemVer("2.0.0"))).toBeLessThan(0);
    expect(compareSemVer(parseSemVer("1.2.0"), parseSemVer("1.10.0"))).toBeLessThan(0);
    expect(compareSemVer(parseSemVer("1.0.1"), parseSemVer("1.0.2"))).toBeLessThan(0);
    expect(compareSemVer(parseSemVer("1.0.0"), parseSemVer("1.0.0"))).toBe(0);
  });

  it("sorts a pre-release before its release", () => {
    // The compatibility rule in the event registry depends on this: a build running
    // 1.0.0-rc.1 must be able to tell it is behind 1.0.0.
    expect(compareSemVer(parseSemVer("1.0.0-rc.1"), parseSemVer("1.0.0"))).toBeLessThan(0);
    expect(compareSemVer(parseSemVer("1.0.0"), parseSemVer("1.0.0-rc.1"))).toBeGreaterThan(0);
    expect(compareSemVer(parseSemVer("1.0.0-alpha"), parseSemVer("1.0.0-beta"))).toBeLessThan(0);
  });
});

describe("language tags", () => {
  it("accepts BCP 47 tags used by audience ingestion", () => {
    expect(parseLanguageTag("en")).toBe("en");
    expect(parseLanguageTag("en-GB")).toBe("en-GB");
    expect(parseLanguageTag("fa-IR")).toBe("fa-IR");
    expect(parseLanguageTag("zh-Hans-CN")).toBe("zh-Hans-CN");
  });

  it("rejects malformed tags", () => {
    for (const invalid of ["", "e", "english", "en-", "-GB", "en-GB-", "12-34"]) {
      expect(tryParseLanguageTag(invalid).ok, invalid).toBe(false);
    }
  });
});

describe("isJsonValue", () => {
  it("accepts the JSON data model", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue("text")).toBe(true);
    expect(isJsonValue(42)).toBe(true);
    expect(isJsonValue(true)).toBe(true);
    expect(isJsonValue([1, "two", null, [3]])).toBe(true);
    expect(isJsonValue({ a: 1, b: { c: [true, null] } })).toBe(true);
    expect(isJsonValue({})).toBe(true);
  });

  it("rejects values JSON cannot represent", () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(() => "fn")).toBe(false);
    expect(isJsonValue(Symbol("s"))).toBe(false);
    expect(isJsonValue(BigInt(1))).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue({ a: undefined })).toBe(false);
    expect(isJsonValue([1, () => 2])).toBe(false);
  });

  it("rejects a circular structure instead of overflowing the stack", () => {
    // `JSON.stringify` throws on a cycle, and a transport would drop the record. The
    // guard has to detect it rather than recurse until the stack is exhausted.
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);

    const nested: Record<string, unknown> = { inner: {} };
    (nested["inner"] as Record<string, unknown>)["back"] = nested;
    expect(isJsonValue(nested)).toBe(false);

    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    expect(isJsonValue(cyclicArray)).toBe(false);
  });

  it("still accepts the same object reached by two different paths", () => {
    // A diamond is not a cycle, and `JSON.stringify` handles it without complaint.
    // Rejecting it would make the guard unusable for any normalised payload.
    const shared = { id: "chr_1" };
    expect(isJsonValue({ left: shared, right: shared })).toBe(true);
  });

  it("rejects objects that serialise lossily", () => {
    // A Date becomes a string and a Map becomes `{}` — both pass a naive walk of own
    // values while silently losing the data they hold.
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map([["a", 1]]))).toBe(false);
    expect(isJsonValue(new Set([1, 2]))).toBe(false);
    expect(isJsonValue({ at: new Date() })).toBe(false);
    expect(
      isJsonValue(
        new (class Point {
          x = 1;
        })(),
      ),
    ).toBe(false);
  });

  it("accepts a plain object with a null prototype", () => {
    // `Object.create(null)` is the shape several JSON parsers produce.
    const bare = Object.create(null) as Record<string, unknown>;
    bare["a"] = 1;
    expect(isJsonValue(bare)).toBe(true);
  });
});

describe("parse results", () => {
  it("unwraps a success", () => {
    expect(unwrapParseResult(tryParseRatio(0.5))).toBe(0.5);
  });

  it("throws a typed error carrying a stable code on a failure", () => {
    // A bare Error cannot be caught selectively, so a caller either swallows it or
    // lets it escape without a machine-readable discriminator.
    let thrown: unknown;
    try {
      unwrapParseResult(tryParseRatio(5));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OmnisTypeError);
    const failure = thrown as OmnisTypeError;
    expect(failure.code).toBe("parse_unwrap_failed");
    expect(failure.message).toContain("expected a value between 0 and 1, received 5");
    expect(failure.toString()).toBe(
      "OmnisTypeError(parse_unwrap_failed): Parse failed: expected a value between 0 and 1, received 5",
    );
  });

  it("narrows with the success and failure guards", () => {
    const ok = tryParseRatio(0.5);
    const bad = tryParseRatio(5);
    expect(isParseSuccess(ok)).toBe(true);
    expect(isParseFailure(ok)).toBe(false);
    expect(isParseSuccess(bad)).toBe(false);
    expect(isParseFailure(bad)).toBe(true);
  });
});
