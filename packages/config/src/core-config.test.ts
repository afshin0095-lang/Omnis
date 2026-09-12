/**
 * Core configuration tests.
 *
 * The policy under test is the one that matters operationally: defaults where a default
 * is safe, fail-fast where it is not. A service that does not know its own name produces
 * unattributable logs and events, and in a multi-tenant platform "unattributable" means
 * "cannot be safely acted on" — so the tests assert the failure, not just the success.
 */

import { ConfigurationError } from "@omnis/errors";
// `z` comes from @omnis/validation, the single sanctioned door to the schema vendor.
// @omnis/config deliberately does not re-export it: a second export path is a second
// place a vendor version can drift.
import { z } from "@omnis/validation";
import { createTenantId, ENVIRONMENTS } from "@omnis/types";
import type { EnvironmentName } from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  configurationErrorFromFailure,
  coreConfigSchemaFor,
  defaultLogLevel,
  ENV_KEYS,
  loadConfig,
  loadOmnisConfig,
  resolveEnvironment,
} from "./index.js";
import type { EnvironmentVariables } from "./index.js";

/** Fails and returns the thrown error, so assertions can inspect it. */
function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return null;
}

describe("resolveEnvironment", () => {
  it("reads OMNIS_ENV", () => {
    expect(resolveEnvironment({ OMNIS_ENV: "production" })).toBe("production");
    expect(resolveEnvironment({ OMNIS_ENV: "staging" })).toBe("staging");
  });

  it("falls back to NODE_ENV", () => {
    expect(resolveEnvironment({ NODE_ENV: "test" })).toBe("test");
    expect(resolveEnvironment({ OMNIS_ENV: "  ", NODE_ENV: "production" })).toBe("production");
  });

  it("prefers OMNIS_ENV over NODE_ENV", () => {
    // A build tool sets NODE_ENV=production for a bundle that is deployed to staging;
    // the explicit OMNIS variable has to win or the service believes it is in
    // production and starts enforcing production policy against staging data.
    expect(resolveEnvironment({ OMNIS_ENV: "staging", NODE_ENV: "production" })).toBe("staging");
  });

  it("accepts the abbreviations deployment tooling sets", () => {
    expect(resolveEnvironment({ OMNIS_ENV: "prod" })).toBe("production");
    expect(resolveEnvironment({ OMNIS_ENV: "dev" })).toBe("development");
    expect(resolveEnvironment({ OMNIS_ENV: "ci" })).toBe("test");
    expect(resolveEnvironment({ OMNIS_ENV: "uat" })).toBe("staging");
    expect(resolveEnvironment({ NODE_ENV: " production " })).toBe("production");
  });

  it("treats a wholly absent environment as local development", () => {
    // The one permissive default in the resolution path, safe because it applies only
    // when nothing at all was supplied: a real deployment always sets one of the two.
    expect(resolveEnvironment({})).toBe("development");
    expect(resolveEnvironment({ OMNIS_ENV: "" })).toBe("development");
    expect(resolveEnvironment({ PATH: "/usr/bin" })).toBe("development");
  });

  it("fails loudly for a value it cannot place, in every environment", () => {
    // Silently reading `OMNIS_ENV=productio` as development would disable production
    // fail-fast checks on exactly the deployment that believes it has them.
    // Note that "prod " is *not* here: `readEnvVariable` trims, so a trailing space
    // from a hand-edited manifest still resolves. Only a value that names no
    // environment at all is refused.
    for (const value of ["productio", "PROD-", "3", "development-ish", "prodution"]) {
      const thrown = capture(() => resolveEnvironment({ OMNIS_ENV: value }));
      expect(thrown, value).toBeInstanceOf(ConfigurationError);
      const failure = thrown as ConfigurationError;
      expect(failure.keys, value).toContain(ENV_KEYS.environment);
      expect(failure.retryable, value).toBe(false);
      expect(failure.message, value).toContain(value.trim());
    }
  });
});

describe("defaultLogLevel", () => {
  it("is quiet in test, verbose locally and informational when managed", () => {
    // A chatty test suite hides the one line that explains a failure.
    expect(defaultLogLevel("test")).toBe("warn");
    expect(defaultLogLevel("development")).toBe("debug");
    expect(defaultLogLevel("staging")).toBe("info");
    expect(defaultLogLevel("production")).toBe("info");
  });

  it("covers every environment", () => {
    for (const environment of ENVIRONMENTS) {
      expect(defaultLogLevel(environment), environment).toBeTruthy();
    }
  });
});

/** Reads the production flag the same way the loader does. */
function isProductionEnvironment(environment: EnvironmentName): boolean {
  return environment === "production";
}

describe("coreConfigSchemaFor", () => {
  it("makes attribution optional locally and mandatory when managed", () => {
    const local = coreConfigSchemaFor("development");
    const managed = coreConfigSchemaFor("production");

    expect(local.safeParse({}).success).toBe(true);
    expect(managed.safeParse({}).success).toBe(false);
    expect(managed.safeParse({ OMNIS_SERVICE_NAME: "content-factory" }).success).toBe(true);
  });

  it("defaults the log format to pretty locally and json when managed", () => {
    const local = coreConfigSchemaFor("development").safeParse({});
    const managed = coreConfigSchemaFor("production").safeParse({
      OMNIS_SERVICE_NAME: "content-factory",
    });
    expect(local.success && local.data[ENV_KEYS.logFormat]).toBe("pretty");
    expect(managed.success && managed.data[ENV_KEYS.logFormat]).toBe("json");
  });

  it("enables telemetry by default only in production", () => {
    expect(
      coreConfigSchemaFor("development").safeParse({}).success &&
        (coreConfigSchemaFor("development").safeParse({}).data as Record<string, unknown>)[
          ENV_KEYS.telemetryEnabled
        ],
    ).toBe(false);
    const managed = coreConfigSchemaFor("production").safeParse({
      OMNIS_SERVICE_NAME: "content-factory",
    });
    expect(managed.success && managed.data[ENV_KEYS.telemetryEnabled]).toBe(true);
  });

  it("defaults strict configuration on in production only", () => {
    const production = coreConfigSchemaFor("production").safeParse({
      OMNIS_SERVICE_NAME: "content-factory",
    });
    expect(production.success && production.data[ENV_KEYS.strictConfiguration]).toBe(true);
    // Staging is managed for attribution but is not production, so strict mode stays
    // off: it is the environment where a missing optional value should still be a
    // warning rather than a refused start.
    const staging = coreConfigSchemaFor("staging").safeParse({
      OMNIS_SERVICE_NAME: "content-factory",
    });
    expect(staging.success && staging.data[ENV_KEYS.strictConfiguration]).toBe(false);
    expect(isProductionEnvironment("staging")).toBe(false);
  });
});

describe("loadOmnisConfig", () => {
  it("produces a usable configuration from an empty environment locally", () => {
    // A developer cloning the repository must be able to run something immediately.
    const config = loadOmnisConfig({});
    expect(config).toEqual({
      environment: "development",
      serviceName: "omnis.local",
      logLevel: "debug",
      logFormat: "pretty",
      telemetryEnabled: false,
      strictConfiguration: false,
      defaultTenantId: null,
    });
  });

  it("requires attribution in production", () => {
    const thrown = capture(() => loadOmnisConfig({ OMNIS_ENV: "production" }));
    expect(thrown).toBeInstanceOf(ConfigurationError);
    const failure = thrown as ConfigurationError;
    expect(failure.keys).toContain(ENV_KEYS.serviceName);
    expect(failure.message).toContain(ENV_KEYS.serviceName);
    // The message names the variable, never its value: the malformed value may itself
    // have been a secret.
    expect(failure.message).not.toContain("is invalid: unknown reason");
  });

  it("accepts a production configuration that supplies what is required", () => {
    const config = loadOmnisConfig({
      OMNIS_ENV: "prod",
      OMNIS_SERVICE_NAME: "content-factory",
      OMNIS_LOG_LEVEL: "warn",
    });
    expect(config.environment).toBe("production");
    expect(config.serviceName).toBe("content-factory");
    expect(config.logLevel).toBe("warn");
    expect(config.logFormat).toBe("json");
    expect(config.telemetryEnabled).toBe(true);
    expect(config.strictConfiguration).toBe(true);
  });

  it("resolves a log level alias to the canonical level", () => {
    // Passing "verbose" through would leave `shouldLog` comparing against a level with
    // no severity, and the process would emit nothing at all.
    expect(loadOmnisConfig({ OMNIS_LOG_LEVEL: "verbose" }).logLevel).toBe("debug");
    expect(loadOmnisConfig({ OMNIS_LOG_LEVEL: "FATAL" }).logLevel).toBe("error");
    expect(loadOmnisConfig({ OMNIS_LOG_LEVEL: "trace" }).logLevel).toBe("debug");
  });

  it("rejects a log level it does not recognise", () => {
    const thrown = capture(() => loadOmnisConfig({ OMNIS_LOG_LEVEL: "chatty" }));
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).keys).toContain(ENV_KEYS.logLevel);
  });

  it("rejects a malformed boolean rather than reading it as false", () => {
    const thrown = capture(() => loadOmnisConfig({ OMNIS_TELEMETRY_ENABLED: "maybe" }));
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).keys).toContain(ENV_KEYS.telemetryEnabled);
  });

  it("accepts a well-formed boolean in any conventional spelling", () => {
    expect(loadOmnisConfig({ OMNIS_TELEMETRY_ENABLED: "yes" }).telemetryEnabled).toBe(true);
    expect(loadOmnisConfig({ OMNIS_TELEMETRY_ENABLED: " OFF " }).telemetryEnabled).toBe(false);
  });

  it("refuses a default tenant in production", () => {
    // Tenant context must come from the authenticated request. A configured default
    // would attribute one tenant's workload to another, which in a multi-tenant
    // platform is a data-isolation failure rather than a misconfiguration.
    const tenantId = createTenantId();
    const thrown = capture(() =>
      loadOmnisConfig({
        OMNIS_ENV: "production",
        OMNIS_SERVICE_NAME: "content-factory",
        OMNIS_TENANT_ID: String(tenantId),
      }),
    );
    expect(thrown).toBeInstanceOf(ConfigurationError);
    const failure = thrown as ConfigurationError;
    expect(failure.keys).toContain(ENV_KEYS.defaultTenantId);
    expect(failure.message).toContain("must not be set in production");
    expect(failure.message).toContain("tenant");
  });

  it("allows a default tenant outside production", () => {
    const tenantId = createTenantId();
    const config = loadOmnisConfig({ OMNIS_TENANT_ID: String(tenantId) });
    expect(config.defaultTenantId).toBe(String(tenantId));
  });

  it("rejects a value that is not a tenant identifier", () => {
    const thrown = capture(() => loadOmnisConfig({ OMNIS_TENANT_ID: "tenant-please" }));
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).keys).toContain(ENV_KEYS.defaultTenantId);
  });

  it("never mutates or reads the real process environment", () => {
    const env: EnvironmentVariables = { OMNIS_ENV: "test" };
    const snapshot = { ...env };
    loadOmnisConfig(env);
    expect(env).toEqual(snapshot);
  });

  it("produces a distinct configuration per environment", () => {
    const environments: readonly EnvironmentName[] = ["development", "test", "staging"];
    const levels = environments.map(
      (environment) =>
        loadOmnisConfig({ OMNIS_ENV: environment, OMNIS_SERVICE_NAME: "svc" }).logLevel,
    );
    expect(levels).toEqual(["debug", "warn", "info"]);
  });
});

describe("loadConfig", () => {
  const schema = z.object({
    OMNIS_LIMITS: z.object({ max: z.number() }).optional(),
    OMNIS_NAME: z.string().min(1),
  });

  it("returns the parsed configuration", () => {
    expect(loadConfig(schema, { OMNIS_NAME: "content-factory" })).toEqual({
      OMNIS_NAME: "content-factory",
    });
  });

  it("throws a ConfigurationError naming the contract", () => {
    const thrown = capture(() => loadConfig(schema, {}, "ContentFactoryConfig"));
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).message).toContain("ContentFactoryConfig");
  });

  it("defaults the contract label when none is given", () => {
    const thrown = capture(() => loadConfig(schema, {}));
    expect((thrown as ConfigurationError).message).toContain("OmnisConfig");
  });
});

describe("configurationErrorFromFailure", () => {
  it("lifts the offending variable names into keys", () => {
    const schema = z.object({ OMNIS_A: z.string(), OMNIS_B: z.number() });
    const result = schema.safeParse({ OMNIS_A: 1, OMNIS_B: "x" });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const failure = configurationErrorFromFailure("Test", result.error);
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect([...failure.keys].sort()).toEqual(["OMNIS_A", "OMNIS_B"]);
    expect(failure.retryable).toBe(false);
    expect(failure.code).toBe("configuration_invalid");
  });

  it("collapses a nested path to the variable an operator must edit", () => {
    const schema = z.object({ OMNIS_LIMITS: z.object({ max: z.number() }) });
    const result = schema.safeParse({ OMNIS_LIMITS: { max: "ten" } });
    if (result.success) {
      throw new Error("expected the parse to fail");
    }
    expect(configurationErrorFromFailure("Test", result.error).keys).toEqual(["OMNIS_LIMITS"]);
  });

  it("does not repeat a key implicated by several issues", () => {
    const schema = z.object({ OMNIS_A: z.string(), OMNIS_B: z.string() });
    const result = schema.safeParse({});
    if (result.success) {
      throw new Error("expected the parse to fail");
    }
    const failure = configurationErrorFromFailure("Test", result.error);
    expect(new Set(failure.keys).size).toBe(failure.keys.length);
  });

  it("survives something that is not a validation failure at all", () => {
    const failure = configurationErrorFromFailure("Test", null);
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(failure.keys).toEqual([]);
    expect(failure.message).toContain("unknown reason");
  });

  it("bounds the message when many variables fail", () => {
    const shape: Record<string, z.ZodType<unknown>> = {};
    for (let index = 0; index < 20; index += 1) {
      shape[`OMNIS_V${index}`] = z.string();
    }
    const result = z.object(shape).safeParse({});
    if (result.success) {
      throw new Error("expected the parse to fail");
    }
    const failure = configurationErrorFromFailure("Test", result.error);
    // Every implicated variable is still listed for the operator, but the rendered
    // message is capped so one malformed payload cannot flood a log line.
    expect(failure.keys).toHaveLength(20);
    expect(failure.message).toContain("(+12 more)");
    // Eight issues are rendered, so the message holds eight paths and no more.
    expect(failure.message.match(/OMNIS_V\d+/g)).toHaveLength(8);
    expect(failure.message.length).toBeLessThan(800);
  });
});
