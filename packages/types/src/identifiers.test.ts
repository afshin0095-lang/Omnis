/**
 * Identifier and ULID tests.
 *
 * Identifiers are the join keys of the whole platform: they appear in event
 * envelopes, log lines, trace context, approval records and every repository query. A
 * malformed one that slips through here becomes an unattributable record somewhere
 * downstream, which is unrecoverable after the fact. So the tests concentrate on the
 * rejections, not just on the happy path.
 */

import { describe, expect, it } from "vitest";
import {
  asCausationId,
  createCharacterId,
  createCommandId,
  createCorrelationId,
  createEntityId,
  createEventId,
  createIdentifier,
  createMonotonicUlid,
  IDENTIFIER_KINDS,
  IDENTIFIER_LENGTH,
  IDENTIFIER_SEPARATOR,
  identifierKindOf,
  InvalidIdentifierError,
  isIdentifierKind,
  isIdentifierOfKind,
  isUlid,
  parseIdentifier,
  tryParseIdentifier,
  ulid,
  ulidTimestamp,
  ULID_LENGTH,
  ULID_RANDOM_LENGTH,
  ULID_TIME_LENGTH,
} from "./index.js";
import type { IdentifierKind } from "./index.js";

/** Every identifier kind, for the tests that must hold across all of them. */
const KINDS = Object.keys(IDENTIFIER_KINDS) as IdentifierKind[];

/** The canonical 26-character Crockford base32 example from the ULID specification. */
const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** A deterministic entropy source, so encoding can be asserted exactly. */
const FIXED_ENTROPY = {
  now: () => 1_700_000_000_000,
  randomBytes: (length: number) => new Uint8Array(length).fill(7),
};

describe("ULID encoding", () => {
  it("produces a 26-character Crockford base32 body", () => {
    expect(ULID_LENGTH).toBe(26);
    expect(ULID_TIME_LENGTH).toBe(10);
    expect(ULID_RANDOM_LENGTH).toBe(16);
    expect(ULID_TIME_LENGTH + ULID_RANDOM_LENGTH).toBe(ULID_LENGTH);

    const value = ulid(FIXED_ENTROPY);
    expect(value).toHaveLength(ULID_LENGTH);
    expect(isUlid(value)).toBe(true);
  });

  it("is deterministic for a fixed clock and entropy source", () => {
    // Without this the generator cannot be tested at all, and a bug in the time
    // encoding would only show up as occasional mis-ordering in production.
    expect(ulid(FIXED_ENTROPY)).toBe(ulid(FIXED_ENTROPY));
  });

  it("encodes the timestamp in the first ten characters", () => {
    const at = 1_700_000_000_000;
    const value = ulid({ now: () => at, randomBytes: FIXED_ENTROPY.randomBytes });
    expect(ulidTimestamp(value)).toBe(at);
  });

  it("excludes the ambiguous Crockford characters", () => {
    // I, L, O and U are excluded from the alphabet so an identifier can be read aloud
    // and transcribed by hand without ambiguity: "I" against "1", "O" against "0".
    expect(VALID_ULID).toHaveLength(ULID_LENGTH);
    expect(isUlid(VALID_ULID)).toBe(true);

    for (const ambiguous of ["I", "L", "O", "U"]) {
      expect(isUlid(ambiguous + VALID_ULID.slice(1)), ambiguous).toBe(false);
    }
    expect(isUlid(VALID_ULID.toLowerCase())).toBe(false);
  });

  it("rejects values that are not ULIDs", () => {
    expect(isUlid("")).toBe(false);
    expect(isUlid(VALID_ULID.slice(0, ULID_LENGTH - 1))).toBe(false);
    expect(isUlid(`${VALID_ULID}0`)).toBe(false);
    expect(isUlid("not-a-ulid")).toBe(false);
  });

  it("generates distinct values from real entropy", () => {
    const values = new Set(Array.from({ length: 200 }, () => ulid()));
    expect(values.size).toBe(200);
  });
});

describe("monotonic ULIDs", () => {
  it("orders strictly by generation within one millisecond", () => {
    // The event store and every audit trail sort by identifier, so two events
    // created in the same millisecond must still compare in causal order.
    const generate = createMonotonicUlid(FIXED_ENTROPY);
    const values = Array.from({ length: 50 }, () => generate());
    const sorted = [...values].sort();
    expect(sorted).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  it("re-uses the clock when it moves forward", () => {
    let now = 1_700_000_000_000;
    const generate = createMonotonicUlid({
      now: () => now,
      randomBytes: FIXED_ENTROPY.randomBytes,
    });
    const first = generate();
    now += 1000;
    const second = generate();
    expect(ulidTimestamp(second)).toBe(1_700_000_001_000);
    expect(ulidTimestamp(first)).toBe(1_700_000_000_000);
    expect(second > first).toBe(true);
  });

  it("does not go backwards when the clock regresses", () => {
    // NTP corrections and VM snapshots both move clocks backwards. An identifier
    // minted after such a correction must still sort after its predecessors.
    let now = 1_700_000_000_000;
    const generate = createMonotonicUlid({
      now: () => now,
      randomBytes: FIXED_ENTROPY.randomBytes,
    });
    const before = generate();
    now -= 5000;
    const after = generate();
    expect(after > before).toBe(true);
  });
});

describe("the identifier namespace", () => {
  it("declares twenty kinds", () => {
    expect(KINDS).toHaveLength(20);
  });

  it("gives every kind a distinct three-character prefix", () => {
    // A collision would make `identifierKindOf` ambiguous, which means an event
    // referencing a character could be read as referencing a channel.
    const prefixes = KINDS.map((kind) => IDENTIFIER_KINDS[kind]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) {
      expect(prefix).toHaveLength(3);
      expect(prefix).toMatch(/^[a-z]{3}$/);
    }
  });

  it("fixes the total length from the prefix, separator and body", () => {
    expect(IDENTIFIER_SEPARATOR).toBe("_");
    expect(IDENTIFIER_LENGTH).toBe(3 + 1 + ULID_LENGTH);
    expect(IDENTIFIER_LENGTH).toBe(30);
  });

  it("recognises its own kind names and nothing else", () => {
    expect(isIdentifierKind("character")).toBe(true);
    expect(isIdentifierKind("tenant")).toBe(true);
    expect(isIdentifierKind("chr")).toBe(false);
    expect(isIdentifierKind("")).toBe(false);
    // Prototype properties must not read as kinds.
    expect(isIdentifierKind("toString")).toBe(false);
    expect(isIdentifierKind("__proto__")).toBe(false);
  });
});

describe("createIdentifier", () => {
  it("mints a well-formed identifier for every kind", () => {
    for (const kind of KINDS) {
      const value = createIdentifier(kind);
      expect(value.startsWith(`${IDENTIFIER_KINDS[kind]}${IDENTIFIER_SEPARATOR}`), kind).toBe(true);
      expect(value, kind).toHaveLength(IDENTIFIER_LENGTH);
      expect(identifierKindOf(value), kind).toBe(kind);
    }
  });

  it("produces distinct identifiers for repeated calls", () => {
    const values = Array.from({ length: 100 }, () => createCharacterId());
    expect(new Set(values).size).toBe(100);
  });

  it("mints identifiers that sort in creation order", () => {
    const values = Array.from({ length: 25 }, () => createEventId());
    expect([...values].sort()).toEqual(values);
  });

  it("exposes a named constructor per kind", () => {
    expect(identifierKindOf(createEntityId())).toBe("entity");
    expect(identifierKindOf(createCharacterId())).toBe("character");
    expect(identifierKindOf(createCommandId())).toBe("command");
    expect(identifierKindOf(createEventId())).toBe("event");
    expect(identifierKindOf(createCorrelationId())).toBe("correlation");
  });
});

describe("identifierKindOf", () => {
  it("reads the kind back off a minted identifier", () => {
    expect(identifierKindOf(createCharacterId())).toBe("character");
    expect(identifierKindOf(createCorrelationId())).toBe("correlation");
  });

  it("returns null rather than guessing", () => {
    const body = ulid(FIXED_ENTROPY);
    expect(identifierKindOf(`chr${IDENTIFIER_SEPARATOR}${body}`)).toBe("character");
    // Unknown prefix.
    expect(identifierKindOf(`zzz${IDENTIFIER_SEPARATOR}${body}`)).toBeNull();
    // Separator in the wrong place.
    expect(identifierKindOf(`ch_r${body.slice(2)}`)).toBeNull();
    // Body is not a ULID.
    expect(identifierKindOf("chr_not-a-ulid")).toBeNull();
    expect(identifierKindOf("")).toBeNull();
    expect(identifierKindOf("chr")).toBeNull();
  });
});

describe("tryParseIdentifier", () => {
  it("accepts an identifier of the requested kind", () => {
    const value = createCharacterId();
    const result = tryParseIdentifier("character", value);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(value);
    }
  });

  it("reports a reason for every rejection", () => {
    const value = createCharacterId();
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["wrong kind", createCorrelationId(), 'expected prefix "chr"'],
      ["non-string", 42, "expected a string, received number"],
      ["undefined", undefined, "expected a string, received undefined"],
      ["too short", String(value).slice(0, 20), "expected 30 characters, received 20"],
      ["too long", `${String(value)}X`, "expected 30 characters, received 31"],
      [
        "bad separator",
        `${String(value).slice(0, 3)}-${String(value).slice(4)}`,
        "missing prefix separator",
      ],
      [
        "bad body",
        `chr_${"0".repeat(ULID_LENGTH)}`.replace(/0/g, "I"),
        "not a valid Crockford base32 ULID",
      ],
    ];
    for (const [label, input, fragment] of cases) {
      const result = tryParseIdentifier("character", input);
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.reason, label).toContain(fragment);
      }
    }
  });

  it("never brands a value it rejected", () => {
    const result = tryParseIdentifier("tenant", "ten_not-a-ulid-at-all-nope-nope-no");
    expect(result.ok).toBe(false);
  });
});

describe("parseIdentifier", () => {
  it("returns the value for a valid identifier", () => {
    const value = createEntityId();
    expect(parseIdentifier("entity", value)).toBe(value);
  });

  it("throws InvalidIdentifierError carrying kind, value and reason", () => {
    const value = createCharacterId();
    let thrown: unknown;
    try {
      parseIdentifier("correlation", value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidIdentifierError);
    const failure = thrown as InvalidIdentifierError;
    expect(failure.kind).toBe("correlation");
    // `received` is the raw value, not a quoted rendering: it is read
    // programmatically as well as printed.
    expect(failure.received).toBe(String(value));
    expect(failure.code).toBe("invalid_identifier");
    expect(failure.message).toContain("correlation");
    // The message quotes the echo, so whitespace and embedded quotes stay visible.
    expect(failure.message).toContain(`"${String(value)}"`);
    expect(failure.message).toContain('expected prefix "cor"');
    // An error that is not an Error breaks every catch-and-log path downstream.
    expect(failure).toBeInstanceOf(Error);
    expect(failure.toString()).toContain("InvalidIdentifierError");
  });

  it("truncates an oversized rejected value so it cannot flood a log", () => {
    let thrown: unknown;
    try {
      parseIdentifier("character", "x".repeat(4000));
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as InvalidIdentifierError;
    expect(failure.received.length).toBeLessThan(100);
    expect(failure.message.length).toBeLessThan(200);
  });

  it("does not echo the rejected value for a non-string input", () => {
    expect(() => parseIdentifier("character", null)).toThrow(InvalidIdentifierError);
    expect(() => parseIdentifier("character", { id: "chr" })).toThrow(InvalidIdentifierError);
  });
});

describe("isIdentifierOfKind", () => {
  it("is true only for the matching kind", () => {
    const character = createCharacterId();
    expect(isIdentifierOfKind("character", character)).toBe(true);
    expect(isIdentifierOfKind("agent", character)).toBe(false);
    expect(isIdentifierOfKind("character", "chr_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isIdentifierOfKind("character", null)).toBe(false);
  });
});

describe("asCausationId", () => {
  it("preserves the source identifier and changes only its role", () => {
    // A causation reference is not a new identifier: it points at the command or
    // event that directly caused this one. The value must survive untouched, or the
    // audit trail loses the link it exists to record.
    const event = createEventId();
    expect(asCausationId(event)).toBe(event);

    const command = createCommandId();
    expect(asCausationId(command)).toBe(command);
  });

  it("stays decodable back to the kind of message that caused it", () => {
    // Because the encoding is unchanged, a consumer holding a causation reference can
    // still tell whether the cause was an event or a command — which is what decides
    // whether the cause can be vetoed or has already happened.
    expect(identifierKindOf(asCausationId(createEventId()))).toBe("event");
    expect(identifierKindOf(asCausationId(createCommandId()))).toBe("command");
  });
});
