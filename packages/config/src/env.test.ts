/**
 * Environment coercion and secret handling tests.
 *
 * Everything in `process.env` is text, and a deployment mistake arrives as text that
 * does not mean what it looks like: `"TRUE "` from a hand-edited manifest, `""` from a
 * templating error, `"12abc"` from a truncated copy. The coercion rules are strict
 * because the alternative — silently reading a malformed flag as "off" — disables a
 * feature in production without anyone deciding to disable it.
 */

import { describe, expect, it } from "vitest";
import {
  booleanEnvSchema,
  createSecret,
  ENV_KEYS,
  integerEnvSchema,
  isEmptySecret,
  isEnvVariableSet,
  isSecretValue,
  listOmnisEnvKeys,
  nonNegativeIntegerEnvSchema,
  positiveIntegerEnvSchema,
  readEnvVariable,
  redactSecretValues,
  SECRET_REDACTED,
} from "./index.js";

describe("ENV_KEYS", () => {
  it("names every core variable with the OMNIS prefix", () => {
    const keys = Object.values(ENV_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key, key).toMatch(/^(OMNIS_|NODE_)/);
    }
    expect(ENV_KEYS.environment).toBe("OMNIS_ENV");
    expect(ENV_KEYS.nodeEnvironment).toBe("NODE_ENV");
    expect(ENV_KEYS.serviceName).toBe("OMNIS_SERVICE_NAME");
  });
});

describe("readEnvVariable", () => {
  it("returns the value for a variable that is set", () => {
    expect(readEnvVariable({ OMNIS_ENV: "production" }, "OMNIS_ENV")).toBe("production");
  });

  it("treats an empty or whitespace-only value as unset", () => {
    // `OMNIS_SERVICE_NAME=` in a manifest is a templating mistake, not a decision to
    // run with an empty service name. Reading it as set would produce unattributable
    // logs instead of a startup failure.
    expect(readEnvVariable({ A: "" }, "A")).toBeUndefined();
    expect(readEnvVariable({ A: "   " }, "A")).toBeUndefined();
    expect(readEnvVariable({ A: "\t\n" }, "A")).toBeUndefined();
    expect(readEnvVariable({}, "A")).toBeUndefined();
  });

  it("trims a value that is set", () => {
    expect(readEnvVariable({ A: "  production  " }, "A")).toBe("production");
  });

  it("does not read prototype properties", () => {
    expect(readEnvVariable({}, "toString")).toBeUndefined();
    expect(readEnvVariable({}, "__proto__")).toBeUndefined();
  });

  it("reports whether a variable is set", () => {
    expect(isEnvVariableSet({ A: "x" }, "A")).toBe(true);
    expect(isEnvVariableSet({ A: "" }, "A")).toBe(false);
    expect(isEnvVariableSet({}, "A")).toBe(false);
  });
});

describe("listOmnisEnvKeys", () => {
  it("lists only OMNIS variables, sorted, and only their names", () => {
    // This feeds the `system.configuration.loaded` event, which reports key names so a
    // missing-variable incident can be diagnosed without any value reaching the stream.
    const env = {
      OMNIS_LOG_LEVEL: "debug",
      NODE_ENV: "test",
      OMNIS_ENV: "test",
      PATH: "/usr/bin",
      OMNIS_API_KEY: "super-secret-value", // omnis-secret-scan:allow fictitious value: proves only key names are listed
    };
    const keys = listOmnisEnvKeys(env);
    expect(keys).toEqual(["OMNIS_API_KEY", "OMNIS_ENV", "OMNIS_LOG_LEVEL"]);
    expect(JSON.stringify(keys)).not.toContain("super-secret-value");
  });

  it("returns an empty list when nothing is prefixed", () => {
    expect(listOmnisEnvKeys({ NODE_ENV: "test", PATH: "/bin" })).toEqual([]);
    expect(listOmnisEnvKeys({})).toEqual([]);
  });
});

describe("booleanEnvSchema", () => {
  it("accepts the conventional spellings of true", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE", "True", "  yes  ", "ON"]) {
      const result = booleanEnvSchema.safeParse(value);
      expect(result.success, value).toBe(true);
      if (result.success) {
        expect(result.data, value).toBe(true);
      }
    }
  });

  it("accepts the conventional spellings of false", () => {
    for (const value of ["false", "0", "no", "off", "FALSE", "Off", " no "]) {
      const result = booleanEnvSchema.safeParse(value);
      expect(result.success, value).toBe(true);
      if (result.success) {
        expect(result.data, value).toBe(false);
      }
    }
  });

  it("rejects anything ambiguous rather than defaulting to false", () => {
    // Coercing "maybe" to false is how telemetry gets switched off in production by a
    // typo, with nobody having decided to switch it off.
    for (const value of ["", "  ", "maybe", "truthy", "2", "enabled", "T", "Y"]) {
      expect(booleanEnvSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    expect(booleanEnvSchema.safeParse(undefined).success).toBe(false);
    expect(booleanEnvSchema.safeParse(true).success).toBe(false);
  });
});

describe("integer environment schemas", () => {
  it("parses integers, including negative ones", () => {
    expect(integerEnvSchema.safeParse("12").success).toBe(true);
    expect(integerEnvSchema.safeParse("-3")).toEqual({ success: true, data: -3 });
    expect(integerEnvSchema.safeParse("  42  ")).toEqual({ success: true, data: 42 });
    expect(integerEnvSchema.safeParse("0")).toEqual({ success: true, data: 0 });
  });

  it("rejects the values a naive Number() coercion would accept", () => {
    // `Number("12abc")` is 12 and `Number("")` is 0; both are wrong answers to a
    // question about a configuration value.
    for (const value of ["12abc", "", "  ", "1.5", "1e3", "0x10", "+5", "１２", "NaN"]) {
      expect(integerEnvSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    expect(integerEnvSchema.safeParse(12).success).toBe(false);
    expect(integerEnvSchema.safeParse(undefined).success).toBe(false);
  });

  it("enforces the sign constraints", () => {
    expect(nonNegativeIntegerEnvSchema.safeParse("0")).toEqual({ success: true, data: 0 });
    expect(nonNegativeIntegerEnvSchema.safeParse("-1").success).toBe(false);
    expect(positiveIntegerEnvSchema.safeParse("1")).toEqual({ success: true, data: 1 });
    expect(positiveIntegerEnvSchema.safeParse("0").success).toBe(false);
    expect(positiveIntegerEnvSchema.safeParse("-1").success).toBe(false);
  });
});

describe("SecretValue", () => {
  it("withholds its value from every implicit conversion", () => {
    const secret = createSecret("hunter2");
    // These are the paths a leak actually takes: a template literal, String(),
    // concatenation and JSON.stringify.
    expect(`${secret}`).toBe(SECRET_REDACTED);
    expect(String(secret)).toBe(SECRET_REDACTED);
    expect("key=" + secret).toBe(`key=${SECRET_REDACTED}`);
    expect(secret.toString()).toBe(SECRET_REDACTED);
    expect(secret.toJSON()).toBe(SECRET_REDACTED);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${SECRET_REDACTED}"}`);
    expect(JSON.stringify([secret])).toBe(`["${SECRET_REDACTED}"]`);
  });

  it("reveals the plaintext only on an explicit call", () => {
    // `reveal()` is greppable and reviewable, which is the whole point: a leak has to
    // be a deliberate act rather than an accident of string interpolation.
    expect(createSecret("hunter2").reveal()).toBe("hunter2");
  });

  it("does not expose the plaintext as an enumerable property", () => {
    const secret = createSecret("hunter2");
    expect(Object.keys(secret)).toEqual(["isSecret", "reveal", "toString", "toJSON", "length"]);
    expect(Object.values(secret)).not.toContain("hunter2");
    expect(JSON.stringify(Object.entries(secret))).not.toContain("hunter2");
  });

  it("reports its length so an 'is it set' check needs no reveal", () => {
    expect(createSecret("abc").length).toBe(3);
    expect(createSecret("").length).toBe(0);
    expect(isEmptySecret(createSecret(""))).toBe(true);
    expect(isEmptySecret(createSecret("abc"))).toBe(false);
  });

  it("distinguishes an empty secret from a missing one", () => {
    // Absent means the feature is unconfigured; present-but-empty usually means a
    // broken deployment. The two need different error messages.
    expect(isEmptySecret(null)).toBe(true);
    expect(isEmptySecret(undefined)).toBe(true);
  });

  it("is recognisable by the type guard", () => {
    expect(isSecretValue(createSecret("x"))).toBe(true);
    expect(isSecretValue({ isSecret: true, reveal: () => "x" })).toBe(true);
    expect(isSecretValue({ isSecret: true })).toBe(false);
    expect(isSecretValue({ isSecret: false, reveal: () => "x" })).toBe(false);
    expect(isSecretValue("hunter2")).toBe(false);
    expect(isSecretValue(null)).toBe(false);
    expect(isSecretValue(undefined)).toBe(false);
  });
});

describe("redactSecretValues", () => {
  it("redacts a secret under an innocuous key", () => {
    // This is the case key- and pattern-based redaction cannot catch: a credential
    // with an unfamiliar shape stored under a name that looks harmless.
    const record = { connection: createSecret("postgres://user:pw@host"), retries: 3 };
    const redacted = redactSecretValues(record);
    expect(redacted).toEqual({ connection: SECRET_REDACTED, retries: 3 });
    expect(JSON.stringify(redacted)).not.toContain("postgres://");
  });

  it("leaves ordinary values untouched", () => {
    expect(redactSecretValues({ a: 1, b: "text", c: null })).toEqual({ a: 1, b: "text", c: null });
    expect(redactSecretValues({})).toEqual({});
  });

  it("does not mutate the record it was given", () => {
    const secret = createSecret("hunter2");
    const record = { secret };
    redactSecretValues(record);
    expect(record.secret).toBe(secret);
    expect(record.secret.reveal()).toBe("hunter2");
  });
});
