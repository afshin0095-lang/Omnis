/**
 * Redaction tests.
 *
 * This is the security-critical module of the package: it is the last thing standing
 * between a credential and a log aggregator, an event payload or an API response. A
 * false negative here is an incident, so the tests enumerate concrete credential
 * shapes rather than asserting a general "looks secret" heuristic.
 *
 * The values used are syntactically valid but fictitious — the right shape, the wrong
 * secret. A test suite that embedded a real key would itself be the leak.
 */

import { describe, expect, it } from "vitest";
import {
  isJsonObjectValue,
  isSensitiveKey,
  isSensitiveValue,
  REDACTED,
  redactAttributes,
  redactObject,
  redactSecrets,
  redactString,
} from "./index.js";

/** A fictitious OpenAI-style secret key: correct shape, 16+ characters. */
const FAKE_OPENAI_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"; // omnis-secret-scan:allow fictitious key: proves redaction catches the OpenAI shape
/** A fictitious GitHub personal access token. */
const FAKE_GITHUB_TOKEN = "ghp_AbCdEfGhIjKlMnOpQrStUvWx"; // omnis-secret-scan:allow fictitious token: proves redaction catches the GitHub shape
/** A fictitious AWS access key id. */
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // omnis-secret-scan:allow fictitious key: proves redaction catches the AWS shape
/** A fictitious JWT: three base64url segments. */
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjaHJfMSJ9.c2lnbmF0dXJlLXBhcnQ"; // omnis-secret-scan:allow fictitious token: proves redaction catches the JWT shape

describe("isSensitiveKey", () => {
  it("flags keys whose tokens name a secret", () => {
    for (const key of [
      "token",
      "password",
      "secret",
      "apiKey",
      "api_key",
      "API-KEY",
      "authorization",
      "cookie",
      "session",
      "credentials",
      "privateKey",
      "clientSecret",
      "cvv",
      "ssn",
      "otp",
      "pin",
      "signature",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("flags the exact multi-token keys whose parts look innocuous", () => {
    for (const key of ["access_token", "refresh_token", "id_token", "client_secret", "x-api-key"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("does not treat a bare plural `keys` as a secret", () => {
    // `ConfigurationError.keys` lists the *names* of missing environment variables.
    // Redacting it would destroy the only actionable content the error carries.
    expect(isSensitiveKey("keys")).toBe(false);
    // A credential collection is named with a modifier that is itself sensitive, and
    // stays caught.
    expect(isSensitiveKey("apiKeys")).toBe(true);
    expect(isSensitiveKey("privateKeys")).toBe(true);
    expect(isSensitiveKey("signingKeys")).toBe(true);
    expect(isSensitiveKey("encryptionKeys")).toBe(true);
    expect(isSensitiveKey("key")).toBe(true);
  });

  it("redacts a credential value even when its key looks harmless", () => {
    // The value patterns run on every string, so removing `keys` from the key
    // denylist does not open a hole for a list of actual credentials.
    // The literal lives in FAKE_OPENAI_KEY rather than here: a formatter is free to move
    // a trailing comment away from the line it annotated, and the secret scanner suppresses
    // per line. A named fixture cannot drift from its marker.
    expect(redactSecrets({ keys: [FAKE_OPENAI_KEY] })).toEqual({
      keys: [REDACTED],
    });
    expect(redactSecrets({ keys: ["OMNIS_LOG_LEVEL", "OMNIS_ENV"] })).toEqual({
      keys: ["OMNIS_LOG_LEVEL", "OMNIS_ENV"],
    });
  });

  it("leaves ordinary keys alone", () => {
    // Substring matching would flag `monkey`, `turkey` and `keyboard`, which is how
    // a redaction layer earns itself an exception list and then gets bypassed.
    for (const key of [
      "monkey",
      "turkey",
      "keyboard",
      "characterId",
      "tenant_id",
      "publishedAt",
      "retryCount",
      "name",
      "",
      "   ",
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("handles camelCase, snake_case, kebab-case and shouting", () => {
    expect(isSensitiveKey("userApiKey")).toBe(true);
    expect(isSensitiveKey("user_api_key")).toBe(true);
    expect(isSensitiveKey("USER-API-KEY")).toBe(true);
    expect(isSensitiveKey("  Token  ")).toBe(true);
  });
});

describe("isSensitiveValue", () => {
  it("recognises high-confidence credential shapes", () => {
    expect(isSensitiveValue(FAKE_OPENAI_KEY)).toBe(true);
    expect(isSensitiveValue(FAKE_GITHUB_TOKEN)).toBe(true);
    expect(isSensitiveValue(FAKE_AWS_KEY)).toBe(true);
    expect(isSensitiveValue(FAKE_JWT)).toBe(true);
    expect(isSensitiveValue("Bearer abcdefghijklmnopqrstuvwxyz")).toBe(true); // omnis-secret-scan:allow fictitious bearer token
    // Assembled rather than written out, for the same reason as the Google key below:
    // GitHub push protection refuses a Slack-shaped literal in the repository, and it is
    // right to. This test needs the shape, not a committed value.
    expect(isSensitiveValue(["xoxb", "1234567890", "abcdefghijklmnop"].join("-"))).toBe(true);
    expect(isSensitiveValue("AIza" + "A".repeat(35))).toBe(true);
    expect(isSensitiveValue("-----BEGIN RSA PRIVATE KEY-----")).toBe(true); // omnis-secret-scan:allow fictitious PEM header: no key material follows
    expect(isSensitiveValue("-----BEGIN PRIVATE KEY-----")).toBe(true); // omnis-secret-scan:allow fictitious PEM header: no key material follows
  });

  it("finds a credential embedded in surrounding prose", () => {
    // The common leak is a message, not a field: "publishing failed for
    // sk-proj-...". Redacting only exact matches would miss every one of those.
    expect(isSensitiveValue(`request failed with key ${FAKE_OPENAI_KEY} for tenant ten_1`)).toBe(
      true,
    );
  });

  it("does not flag ordinary content", () => {
    // The patterns are deliberately conservative: a redaction layer that eats normal
    // text gets disabled, and then it protects nothing.
    for (const value of [
      "character.published",
      "sk-", // far too short to be a key
      "The quick brown fox",
      "tenant_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "AKIA123", // wrong length for an AWS key id
      "eyJhbGciOiJIUzI1NiJ9", // a single JWT segment is not a token
      "",
    ]) {
      expect(isSensitiveValue(value), value).toBe(false);
    }
  });
});

describe("redactString", () => {
  it("replaces a credential and preserves ordinary text", () => {
    expect(redactString(FAKE_OPENAI_KEY)).toBe(REDACTED);
    expect(redactString("character.created")).toBe("character.created");
  });

  it("masks every occurrence rather than only the first", () => {
    const value = `${FAKE_OPENAI_KEY} and ${FAKE_GITHUB_TOKEN} and ${FAKE_OPENAI_KEY}`;
    const redacted = redactString(value);
    expect(redacted).toBe(`${REDACTED} and ${REDACTED} and ${REDACTED}`);
    expect(isSensitiveValue(redacted)).toBe(false);
  });

  it("is idempotent, so redacting twice cannot corrupt a message", () => {
    const once = redactString(`failed with ${FAKE_AWS_KEY}`);
    expect(redactString(once)).toBe(once);
  });

  it("gives the same answer on repeated calls", () => {
    // A `g`-flagged RegExp advances `lastIndex` between `.test()` calls. Detection
    // uses non-global patterns precisely so that repeating a check cannot flip its
    // result — which would make redaction depend on call history.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(isSensitiveValue(FAKE_OPENAI_KEY), `attempt ${attempt}`).toBe(true);
      expect(isSensitiveValue("plain text"), `attempt ${attempt}`).toBe(false);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts sensitive keys at any depth", () => {
    const input = {
      tenantId: "ten_1",
      provider: { apiKey: FAKE_OPENAI_KEY, endpoint: "https://api.example.com" },
      sessions: [{ token: FAKE_JWT, id: "ses_1" }],
    };
    expect(redactSecrets(input)).toEqual({
      tenantId: "ten_1",
      provider: { apiKey: REDACTED, endpoint: "https://api.example.com" },
      sessions: [{ token: REDACTED, id: "ses_1" }],
    });
  });

  it("redacts sensitive values under innocuous keys, keeping the rest of the text", () => {
    expect(redactSecrets({ detail: FAKE_GITHUB_TOKEN })).toEqual({ detail: REDACTED });
    // Masking the span rather than the whole string keeps the diagnosis: the tenant
    // and the operation are exactly what an engineer needs once the secret is gone.
    expect(redactSecrets({ detail: `failed with ${FAKE_GITHUB_TOKEN} for ten_1` })).toEqual({
      detail: `failed with ${REDACTED} for ten_1`,
    });
  });

  it("coerces values JSON cannot carry", () => {
    expect(
      redactSecrets({
        nothing: undefined,
        fn: () => "x",
        sym: Symbol("s"),
        big: BigInt(9),
        nan: Number.NaN,
        infinity: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      nothing: null,
      fn: null,
      sym: null,
      big: null,
      nan: null,
      infinity: null,
    });
  });

  it("renders a Date as an ISO string and an Error as name and message", () => {
    expect(redactSecrets({ at: new Date("2026-09-11T12:00:00.000Z") })).toEqual({
      at: "2026-09-11T12:00:00.000Z",
    });
    expect(redactSecrets({ at: new Date("nonsense") })).toEqual({ at: null });
    expect(redactSecrets({ why: new Error("boom") })).toEqual({
      why: { name: "Error", message: "boom" },
    });
    // A secret in the message of a nested error is still a secret.
    expect(redactSecrets({ why: new Error(`boom ${FAKE_AWS_KEY}`) })).toEqual({
      why: { name: "Error", message: `boom ${REDACTED}` },
    });
  });

  it("marks a circular reference instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { id: "chr_1" };
    cyclic["self"] = cyclic;
    expect(redactSecrets(cyclic)).toEqual({ id: "chr_1", self: "[Circular]" });
  });

  it("still redacts the same object reached twice", () => {
    // A diamond is not a cycle: dropping the second occurrence would lose data that
    // `JSON.stringify` handles without complaint.
    const shared = { token: FAKE_JWT };
    expect(redactSecrets({ left: shared, right: shared })).toEqual({
      left: { token: REDACTED },
      right: { token: REDACTED },
    });
  });

  it("stops at the depth limit rather than truncating mid-structure", () => {
    const deep = { a: { b: { c: { d: "value" } } } };
    expect(redactSecrets(deep, 2)).toEqual({ a: { b: REDACTED } });
    expect(redactSecrets(deep)).toEqual(deep);
  });

  it("preserves array shape", () => {
    expect(redactSecrets([1, "two", { password: "hunter2" }, null])).toEqual([
      1,
      "two",
      { password: REDACTED },
      null,
    ]);
  });

  it("does not mutate its input", () => {
    // The caller usually still needs the original — for example to authenticate with
    // the very credential that must not be logged.
    const input = { provider: { apiKey: FAKE_OPENAI_KEY }, count: 1 };
    const snapshot = JSON.parse(
      JSON.stringify({ provider: { apiKey: FAKE_OPENAI_KEY }, count: 1 }),
    ) as unknown;
    redactSecrets(input);
    expect(input).toEqual(snapshot);
    expect(input.provider.apiKey).toBe(FAKE_OPENAI_KEY);
  });

  it("returns scalars unchanged when they are not secrets", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(7)).toBe(7);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeNull();
  });
});

describe("redactObject", () => {
  it("returns an object for object input", () => {
    expect(redactObject({ token: FAKE_JWT, kept: 1 })).toEqual({ token: REDACTED, kept: 1 });
  });

  it("wraps a non-object under a value key instead of discarding it", () => {
    // A thrown string is common (`throw "nope"`), and losing it would leave the log
    // line with no indication of what happened.
    expect(redactObject("nope")).toEqual({ value: "nope" });
    expect(redactObject(42)).toEqual({ value: 42 });
    expect(redactObject(null)).toEqual({ value: null });
    expect(redactObject([1, 2])).toEqual({ value: [1, 2] });
  });
});

describe("redactAttributes", () => {
  it("preserves the key set so the shape stays diagnosable", () => {
    // Knowing that a field existed is usually what makes a bug diagnosable, even when
    // its contents had to be withheld.
    const redacted = redactAttributes({ apiKey: FAKE_OPENAI_KEY, tenantId: "ten_1" });
    expect(Object.keys(redacted).sort()).toEqual(["apiKey", "tenantId"]);
    expect(redacted["apiKey"]).toBe(REDACTED);
    expect(redacted["tenantId"]).toBe("ten_1");
  });

  it("returns an empty object for no attributes", () => {
    expect(redactAttributes({})).toEqual({});
  });
});

describe("isJsonObjectValue", () => {
  it("accepts objects and rejects arrays, null and scalars", () => {
    expect(isJsonObjectValue({ a: 1 })).toBe(true);
    expect(isJsonObjectValue({})).toBe(true);
    expect(isJsonObjectValue([])).toBe(false);
    expect(isJsonObjectValue(null)).toBe(false);
    expect(isJsonObjectValue("text")).toBe(false);
    expect(isJsonObjectValue(1)).toBe(false);
  });
});
