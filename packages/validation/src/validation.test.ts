/**
 * Validation tests.
 *
 * This package is the only sanctioned door between untyped input and a branded type,
 * so the tests concentrate on three things: that every primitive schema delegates to
 * the `@omnis/types` parser rather than restating its rule, that a failure carries
 * enough structure to be actionable, and that nothing attacker-controlled reaches an
 * error message unredacted.
 */

import { ValidationError } from "@omnis/errors";
import {
  asCausationId,
  createCharacterId,
  createCommandId,
  createEventId,
  createIdentifier,
  createTenantId,
  IDENTIFIER_KINDS,
  LOG_LEVELS,
  SOCIAL_PLATFORMS,
} from "@omnis/types";
import type { IdentifierKind, LogLevel } from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  causationIdSchema,
  commandNameSchema,
  contractLabel,
  describeSchema,
  emailAddressSchema,
  environmentSchema,
  eventTypeSchema,
  identifierSchema,
  identifierSchemas,
  isoDateTimeSchema,
  isValid,
  jsonObjectSchema,
  jsonValueSchema,
  languageTagSchema,
  logFormatSchema,
  logLevelSchema,
  nonEmptyStringSchema,
  percentageSchema,
  ratioSchema,
  semVerSchema,
  serviceNameSchema,
  socialPlatformSchema,
  summariseIssues,
  toValidationIssues,
  trimmedStringSchema,
  tryValidate,
  tryValidateContract,
  uriSchema,
  utcTimestampSchema,
  validate,
  validateContract,
  z,
} from "./index.js";
import type { OmnisSchema, ValidationIssue } from "./index.js";

/** Mints an identifier of a kind the schema set does not expose a helper for. */
function createIdentifierOfKind(kind: "causation"): string {
  return createIdentifier(kind);
}

/** A fictitious credential: correct shape, wrong secret. */
const FAKE_SECRET = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"; // omnis-secret-scan:allow fictitious key: proves validation issues redact the offending value

describe("the vendor entry point", () => {
  it("re-exports the schema builder so nothing else needs the vendor", () => {
    // Importing `z` from here rather than from the vendor is what keeps the library
    // replaceable: a second import path is a second place a version can drift.
    expect(typeof z.object).toBe("function");
    expect(typeof z.string).toBe("function");
    expect(z.object({ a: z.string() }).safeParse({ a: "x" }).success).toBe(true);
  });
});

describe("identifier schemas", () => {
  it("covers every identifier kind", () => {
    const kinds = Object.keys(IDENTIFIER_KINDS) as IdentifierKind[];
    expect(Object.keys(identifierSchemas).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      expect(identifierSchemas[kind], kind).toBeTruthy();
    }
  });

  it("accepts an identifier of its own kind", () => {
    const character = createCharacterId();
    expect(identifierSchemas.character.safeParse(character).success).toBe(true);
    expect(identifierSchema("tenant").safeParse(createTenantId()).success).toBe(true);
  });

  it("rejects an identifier of a different kind", () => {
    // A character id in a tenant slot is the failure that turns one tenant's data
    // into another's, so it must not be a silent pass.
    const tenant = createTenantId();
    expect(identifierSchemas.character.safeParse(tenant).success).toBe(false);
    expect(identifierSchemas.tenant.safeParse(createCharacterId()).success).toBe(false);
  });

  it("rejects values that are not identifiers at all", () => {
    for (const value of [undefined, null, 42, "", "chr_1", "character", {}, ["chr_1"]]) {
      expect(identifierSchemas.character.safeParse(value).success, String(value)).toBe(false);
    }
  });

  it("names the expected shape in the failure message", () => {
    const result = identifierSchemas.character.safeParse("nope");
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = toValidationIssues(result.error);
      expect(issues[0]?.message).toContain("character");
      expect(issues[0]?.message).toContain("chr_<ULID>");
    }
  });

  it("produces a distinct schema instance per kind", () => {
    // A shared instance would make every kind accept every identifier.
    expect(identifierSchema("character")).not.toBe(identifierSchema("tenant"));
  });
});

describe("causationIdSchema", () => {
  it("accepts the identifier of the causing message, whatever its kind", () => {
    // A causation reference *is* the causing event's or command's identifier:
    // `asCausationId` changes the role, not the value. Demanding a `cau_` prefix here
    // would reject every reference `createCausedEvent` produces.
    expect(causationIdSchema.safeParse(asCausationId(createEventId())).success).toBe(true);
    expect(causationIdSchema.safeParse(asCausationId(createCommandId())).success).toBe(true);
    expect(causationIdSchema.safeParse(createEventId()).success).toBe(true);
    expect(causationIdSchema.safeParse(createCommandId()).success).toBe(true);
    expect(causationIdSchema.safeParse(createIdentifierOfKind("causation")).success).toBe(true);
  });

  it("rejects an identifier that cannot have caused anything", () => {
    expect(causationIdSchema.safeParse(createCharacterId()).success).toBe(false);
    expect(causationIdSchema.safeParse(createTenantId()).success).toBe(false);
    expect(causationIdSchema.safeParse("cau_1").success).toBe(false);
    expect(causationIdSchema.safeParse(null).success).toBe(false);
  });
});

describe("primitive schemas", () => {
  it("validates timestamps", () => {
    expect(isoDateTimeSchema.safeParse("2026-09-11T12:00:00.000Z").success).toBe(true);
    expect(isoDateTimeSchema.safeParse("2026-09-11T12:00:00+03:30").success).toBe(false);
    expect(isoDateTimeSchema.safeParse("2026-02-31T00:00:00.000Z").success).toBe(false);
    // The alias is the same object, so the two cannot drift apart.
    expect(utcTimestampSchema).toBe(isoDateTimeSchema);
  });

  it("validates URIs and email addresses", () => {
    expect(uriSchema.safeParse("https://omnis.ai/characters").success).toBe(true);
    expect(uriSchema.safeParse("/relative").success).toBe(false);
    expect(emailAddressSchema.safeParse("ops@omnis.ai").success).toBe(true);
    expect(emailAddressSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("never echoes a rejected email address", () => {
    const result = emailAddressSchema.safeParse("someone@invalid-domain");
    expect(result.success).toBe(false);
    if (!result.success) {
      const rendered = JSON.stringify(toValidationIssues(result.error));
      expect(rendered).not.toContain("someone@invalid-domain");
    }
  });

  it("validates bounded numbers", () => {
    expect(percentageSchema.safeParse(0).success).toBe(true);
    expect(percentageSchema.safeParse(100).success).toBe(true);
    expect(percentageSchema.safeParse(100.5).success).toBe(false);
    expect(ratioSchema.safeParse(0.5).success).toBe(true);
    expect(ratioSchema.safeParse(1.5).success).toBe(false);
    expect(ratioSchema.safeParse(Number.NaN).success).toBe(false);
    expect(percentageSchema.safeParse("50").success).toBe(false);
  });

  it("validates semantic versions", () => {
    expect(semVerSchema.safeParse("1.0.0").success).toBe(true);
    expect(semVerSchema.safeParse("1.0.0-rc.1").success).toBe(true);
    expect(semVerSchema.safeParse("1.0").success).toBe(false);
    expect(semVerSchema.safeParse("v1.0.0").success).toBe(false);
  });

  it("validates event types and command names", () => {
    expect(eventTypeSchema.safeParse("character.created").success).toBe(true);
    expect(eventTypeSchema.safeParse("charactercreated").success).toBe(false);
    expect(eventTypeSchema.safeParse("Character.Created").success).toBe(false);
    expect(commandNameSchema.safeParse("content.production.start").success).toBe(true);
    expect(commandNameSchema.safeParse("Content.Production.Start").success).toBe(false);
  });

  it("validates language tags", () => {
    expect(languageTagSchema.safeParse("en-GB").success).toBe(true);
    expect(languageTagSchema.safeParse("fa-IR").success).toBe(true);
    expect(languageTagSchema.safeParse("english").success).toBe(false);
  });

  it("validates strings", () => {
    expect(trimmedStringSchema.safeParse("omnis").success).toBe(true);
    expect(trimmedStringSchema.safeParse("   ").success).toBe(false);
    expect(nonEmptyStringSchema.safeParse("omnis").success).toBe(true);
    expect(nonEmptyStringSchema.safeParse("").success).toBe(false);
  });

  it("validates service names", () => {
    expect(serviceNameSchema.safeParse("content-factory").success).toBe(true);
    expect(serviceNameSchema.safeParse("audience-intelligence.ingestion").success).toBe(true);
    expect(serviceNameSchema.safeParse("ContentFactory").success).toBe(false);
    expect(serviceNameSchema.safeParse("-leading").success).toBe(false);
    expect(serviceNameSchema.safeParse("").success).toBe(false);
  });

  it("validates social platforms strictly, leaving normalisation to ingestion", () => {
    for (const platform of SOCIAL_PLATFORMS) {
      expect(socialPlatformSchema.safeParse(platform).success, platform).toBe(true);
    }
    // Loose spellings are resolved by `normaliseSocialPlatform` at the ingestion
    // boundary. Accepting them here would let two spellings of one platform into
    // stored data, which is how analytics end up counting the same channel twice.
    expect(socialPlatformSchema.safeParse("twitter").success).toBe(false);
    expect(socialPlatformSchema.safeParse("YouTube").success).toBe(false);
    expect(socialPlatformSchema.safeParse("linkedin").success).toBe(false);
  });

  it("validates JSON values", () => {
    expect(jsonValueSchema.safeParse({ a: [1, "two", null, true] }).success).toBe(true);
    expect(jsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse(() => "fn").success).toBe(false);
    expect(jsonObjectSchema.safeParse({ a: 1 }).success).toBe(true);
    expect(jsonObjectSchema.safeParse([1]).success).toBe(false);
    expect(jsonObjectSchema.safeParse("text").success).toBe(false);
    expect(jsonObjectSchema.safeParse({}).success).toBe(true);
  });
});

describe("environmentSchema", () => {
  it("accepts canonical names and yields them unchanged", () => {
    for (const environment of ["development", "test", "staging", "production"]) {
      const result = environmentSchema.safeParse(environment);
      expect(result.success, environment).toBe(true);
      if (result.success) {
        expect(result.data).toBe(environment);
      }
    }
  });

  it("normalises the abbreviations deployment tooling actually sets", () => {
    // `resolveEnvironment` in @omnis/config accepts these; a schema that refused them
    // would let `OMNIS_ENV=prod` resolve and then fail validation one line later.
    const aliases: readonly (readonly [string, string])[] = [
      ["prod", "production"],
      ["PROD", "production"],
      ["dev", "development"],
      ["local", "development"],
      ["ci", "test"],
      ["uat", "staging"],
      ["preprod", "staging"],
    ];
    for (const [input, expected] of aliases) {
      const result = environmentSchema.safeParse(input);
      expect(result.success, input).toBe(true);
      if (result.success) {
        expect(result.data, input).toBe(expected);
      }
    }
  });

  it("rejects a value it cannot place", () => {
    for (const value of ["banana", "", "productionish", 3, null, undefined, {}]) {
      expect(environmentSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe("logLevelSchema", () => {
  it("accepts canonical levels unchanged", () => {
    for (const level of LOG_LEVELS) {
      const result = logLevelSchema.safeParse(level);
      expect(result.success, level).toBe(true);
      if (result.success) {
        expect(result.data, level).toBe(level);
      }
    }
  });

  it("resolves aliases to the canonical level instead of passing them through", () => {
    // A predicate-only schema would hand back "verbose" branded as a LogLevel: a value
    // with no severity entry, against which every threshold comparison is false, so
    // the process logs nothing at all.
    const aliases: readonly (readonly [string, LogLevel])[] = [
      ["verbose", "debug"],
      ["trace", "debug"],
      ["DEBUG", "debug"],
      ["information", "info"],
      ["notice", "info"],
      ["warning", "warn"],
      ["fatal", "error"],
      ["critical", "error"],
      ["severe", "error"],
    ];
    for (const [input, expected] of aliases) {
      const result = logLevelSchema.safeParse(input);
      expect(result.success, input).toBe(true);
      if (result.success) {
        expect(result.data, input).toBe(expected);
        expect(LOG_LEVELS).toContain(result.data);
      }
    }
  });

  it("rejects a level it does not recognise", () => {
    for (const value of ["chatty", "", "ERR", 3, null, undefined]) {
      expect(logLevelSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe("logFormatSchema", () => {
  it("accepts exactly the two supported formats", () => {
    expect(logFormatSchema.safeParse("json").success).toBe(true);
    expect(logFormatSchema.safeParse("pretty").success).toBe(true);
    expect(logFormatSchema.safeParse("text").success).toBe(false);
    expect(logFormatSchema.safeParse("JSON").success).toBe(false);
  });
});

describe("tryValidate", () => {
  const schema = z.object({ name: trimmedStringSchema, age: percentageSchema });

  it("returns the parsed value on success", () => {
    const result = tryValidate(schema, { name: "omnis", age: 10 });
    expect(result).toEqual({ ok: true, value: { name: "omnis", age: 10 } });
  });

  it("returns a summarised reason on failure", () => {
    const result = tryValidate(schema, { name: "  ", age: 500 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("name");
      expect(result.reason).toContain("age");
    }
  });

  it("does not throw for input that is not an object at all", () => {
    expect(tryValidate(schema, null).ok).toBe(false);
    expect(tryValidate(schema, "text").ok).toBe(false);
    expect(tryValidate(schema, undefined).ok).toBe(false);
  });
});

describe("validate", () => {
  const schema = z.object({ title: trimmedStringSchema });

  it("returns the parsed value on success", () => {
    expect(validate(schema, { title: "hello" })).toEqual({ title: "hello" });
  });

  it("throws a ValidationError carrying structured issues", () => {
    let thrown: unknown;
    try {
      validate(schema, { title: "" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const failure = thrown as ValidationError;
    expect(failure.issues.length).toBeGreaterThan(0);
    expect(failure.issues[0]?.path).toBe("title");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("title");
  });

  it("names the contract in the message when one is supplied", () => {
    // An anonymous "validation failed" tells an on-call engineer nothing about which
    // producer or which version disagreed.
    expect(() => validate(schema, {}, "CharacterDraft@1.2.0")).toThrow(
      /CharacterDraft@1\.2\.0 validation failed/,
    );
    expect(() => validate(schema, {})).toThrow(/^schema validation failed/);
  });

  it("reports every issue for a payload that fails in several places", () => {
    const wide = z.object({ a: trimmedStringSchema, b: ratioSchema, c: semVerSchema });
    let thrown: unknown;
    try {
      validate(wide, { a: "", b: 9, c: "nope" }, "Wide");
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as ValidationError;
    expect(failure.issues).toHaveLength(3);
    expect(failure.issues.map((issue) => issue.path).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("schema descriptors", () => {
  const schema = z.object({ title: trimmedStringSchema });

  it("renders the contract label with and without a version", () => {
    expect(contractLabel(describeSchema("CharacterDraft", schema))).toBe("CharacterDraft");
    expect(contractLabel(describeSchema("CharacterDraft", schema, "1.2.0"))).toBe(
      "CharacterDraft@1.2.0",
    );
  });

  it("keeps an absent version absent rather than undefined-valued", () => {
    // `"version" in descriptor` is how a consumer distinguishes "unversioned contract"
    // from "versioned contract whose version is unknown".
    expect("version" in describeSchema("CharacterDraft", schema)).toBe(false);
    expect("version" in describeSchema("CharacterDraft", schema, "1.0.0")).toBe(true);
  });

  it("names the contract when validation fails", () => {
    const descriptor = describeSchema("EventEnvelope", schema, "1.0.0");
    expect(() => validateContract(descriptor, {})).toThrow(/EventEnvelope@1\.0\.0/);
    expect(tryValidateContract(descriptor, { title: "ok" }).ok).toBe(true);
    expect(tryValidateContract(descriptor, {}).ok).toBe(false);
  });
});

describe("isValid", () => {
  it("narrows without throwing", () => {
    const values: readonly unknown[] = ["omnis", "", 42, null];
    expect(values.filter((value) => isValid(trimmedStringSchema, value))).toEqual(["omnis"]);
  });
});

describe("toValidationIssues", () => {
  it("normalises a vendor failure into a stable shape", () => {
    const schema = z.object({ nested: z.object({ title: trimmedStringSchema }) });
    const result = schema.safeParse({ nested: { title: "" } });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const issues = toValidationIssues(result.error);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("nested.title");
    expect(typeof issues[0]?.code).toBe("string");
    expect(typeof issues[0]?.message).toBe("string");
    expect("received" in (issues[0] as ValidationIssue)).toBe(true);
  });

  it("renders array indices as plain path segments", () => {
    const schema = z.object({ items: z.array(trimmedStringSchema) });
    const result = schema.safeParse({ items: ["ok", ""] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toValidationIssues(result.error)[0]?.path).toBe("items.1");
    }
  });

  it("returns an empty list for something that is not a validation failure", () => {
    expect(toValidationIssues(null)).toEqual([]);
    expect(toValidationIssues("nope")).toEqual([]);
    expect(toValidationIssues({})).toEqual([]);
    expect(toValidationIssues({ issues: "not-an-array" })).toEqual([]);
    expect(toValidationIssues({ issues: [null, 7, "x"] })).toEqual([]);
  });

  it("fills in a code and message when the vendor omits them", () => {
    const issues = toValidationIssues({ issues: [{ path: [] }] });
    expect(issues).toEqual([
      { path: "", code: "invalid", message: "Validation failed", received: null },
    ]);
  });

  it("redacts a secret that arrived inside the rejected input", () => {
    // `received` is attacker-controlled by definition — it is the input that failed —
    // so it is the most likely place for a credential to be sitting.
    const issues = toValidationIssues({
      issues: [{ path: ["authorization"], code: "invalid", message: "no", received: FAKE_SECRET }],
    });
    expect(JSON.stringify(issues)).not.toContain(FAKE_SECRET);
    expect(issues[0]?.received).toBe("[REDACTED]");
  });

  it("coerces a non-JSON received value into something serializable", () => {
    const issues = toValidationIssues({
      issues: [{ path: ["a"], received: Number.NaN }],
    });
    expect(issues[0]?.received).toBeNull();
    expect(() => JSON.stringify(issues)).not.toThrow();
  });
});

describe("summariseIssues", () => {
  const issue = (path: string, message: string): ValidationIssue => ({
    path,
    code: "invalid",
    message,
    received: null,
  });

  it("renders nothing as an explicit unknown reason", () => {
    // An empty message in an error is indistinguishable from a bug in the formatter.
    expect(summariseIssues([])).toBe("unknown reason");
  });

  it("joins issues with their paths", () => {
    expect(summariseIssues([issue("a", "first"), issue("b.c", "second")])).toBe(
      "a: first; b.c: second",
    );
  });

  it("omits the path for a failure at the root", () => {
    expect(summariseIssues([issue("", "root failure")])).toBe("root failure");
  });

  it("bounds the summary and reports how much was withheld", () => {
    // A deeply malformed payload can produce hundreds of issues; an unbounded message
    // floods log lines and error responses. The full list stays on the error.
    const issues = Array.from({ length: 12 }, (_, index) => issue(`f${index}`, `bad ${index}`));
    const summary = summariseIssues(issues);
    expect(summary).toContain("(+7 more)");
    expect(summary.split(";")).toHaveLength(5);
    expect(summariseIssues(issues, 2)).toContain("(+10 more)");
    expect(summariseIssues(issues.slice(0, 5))).not.toContain("more");
  });
});

describe("the OmnisSchema contract", () => {
  it("is satisfied by a schema that is not from the vendor", () => {
    // The point of the interface is that the platform is not welded to one validation
    // library: a hand-rolled object with a `safeParse` is a first-class schema.
    const evenNumber: OmnisSchema<number> = {
      safeParse(input: unknown) {
        if (typeof input === "number" && Number.isInteger(input) && input % 2 === 0) {
          return { success: true, data: input };
        }
        return {
          success: false,
          error: { issues: [{ path: [], code: "not_even", message: "Expected an even integer" }] },
        };
      },
    };

    expect(validate(evenNumber, 4)).toBe(4);
    expect(tryValidate(evenNumber, 3).ok).toBe(false);
    expect(isValid(evenNumber, 3)).toBe(false);
    expect(() => validate(evenNumber, 3, "EvenNumber")).toThrow(ValidationError);
  });
});
