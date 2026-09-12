/**
 * Error hierarchy tests.
 *
 * Every error OMNIS raises crosses at least one boundary: into a structured log, onto
 * a queue, or back to an API client. The two properties that matter at those
 * boundaries are that the classification survives (so a consumer can branch on it
 * without string-matching a message) and that no secret survives with it. The
 * round-trip tests below exist because an error that serializes but cannot be
 * rebuilt is only half a contract.
 */

import { nowIso, tryParseIsoDateTime } from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
  compactDetails,
  ConflictError,
  ConfigurationError,
  ContractError,
  ERROR_CODES,
  ERROR_CODE_VALUES,
  ExecutionError,
  httpStatusForCode,
  InfrastructureError,
  isOmnisError,
  isOmnisErrorCode,
  isRetryableCode,
  NotImplementedError,
  NotFoundError,
  OmnisError,
  omnisErrorFromSerialized,
  PolicyViolationError,
  ProviderError,
  REDACTED,
  TimeoutError,
  toOmnisError,
  ValidationError,
} from "./index.js";
import type { SerializedOmnisError } from "./index.js";

/** A fictitious credential, correct shape and wrong secret. */
const FAKE_SECRET = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"; // omnis-secret-scan:allow fictitious key: proves serialized errors redact before output

/** One instance of every concrete error in the hierarchy. */
function oneOfEach(): readonly OmnisError[] {
  return [
    new ValidationError("payload rejected", {
      issues: [{ path: "title", code: "too_small", message: "required", received: null }],
    }),
    new ConfigurationError("environment incomplete", { keys: ["OMNIS_LOG_LEVEL"] }),
    new NotFoundError("character", "chr_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    new ConflictError("stale-version", "expected version 3, found 4"),
    new AuthenticationError("session expired"),
    new AuthorizationError("not permitted", { permission: "publishing.schedule" }),
    new PolicyViolationError("policy.autonomy.publish", "budget exceeded", {
      rule: "daily-spend-cap",
      requiresApproval: true,
    }),
    new ProviderError("openai", "rate limited", {
      providerRef: "req_1",
      providerStatus: "429",
    }),
    new ExecutionError("tool call failed", { executionId: "exe_1" }),
    new TimeoutError("deadline exceeded", { timeoutMs: 5000, operation: "render" }),
    new InfrastructureError("postgres", "connection refused"),
    new ContractError("EventEnvelope", "major version mismatch", {
      contractVersion: "1.0.0",
      receivedVersion: "2.0.0",
    }),
    new NotImplementedError("video.render", { trackedIn: "docs/06-roadmap" }),
    new OmnisError(ERROR_CODES.unknown, "unclassified"),
  ];
}

describe("the error code vocabulary", () => {
  it("declares fourteen stable codes", () => {
    expect(ERROR_CODE_VALUES).toHaveLength(14);
    expect(new Set(ERROR_CODE_VALUES).size).toBe(ERROR_CODE_VALUES.length);
  });

  it("uses snake_case wire values", () => {
    for (const code of ERROR_CODE_VALUES) {
      expect(code, code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    }
  });

  it("recognises its own codes and nothing else", () => {
    for (const code of ERROR_CODE_VALUES) {
      expect(isOmnisErrorCode(code), code).toBe(true);
    }
    expect(isOmnisErrorCode("validation-failed")).toBe(false);
    expect(isOmnisErrorCode("validationFailed")).toBe(false);
    expect(isOmnisErrorCode("")).toBe(false);
    expect(isOmnisErrorCode(null)).toBe(false);
    expect(isOmnisErrorCode(400)).toBe(false);
  });

  it("derives the value tuple from the record so they cannot drift", () => {
    expect(ERROR_CODE_VALUES).toEqual(Object.values(ERROR_CODES));
  });

  it("marks only transient failures as retryable by default", () => {
    // Retryability drives queue redelivery. Retrying a validation failure or a policy
    // rejection burns quota and can re-trigger a side effect that was refused once.
    const retryable = ERROR_CODE_VALUES.filter((code) => isRetryableCode(code));
    expect(retryable.sort()).toEqual(
      [
        ERROR_CODES.executionFailed,
        ERROR_CODES.infrastructureFailure,
        ERROR_CODES.providerFailure,
        ERROR_CODES.timeout,
      ].sort(),
    );
    expect(isRetryableCode(ERROR_CODES.validationFailed)).toBe(false);
    expect(isRetryableCode(ERROR_CODES.policyViolation)).toBe(false);
    expect(isRetryableCode(ERROR_CODES.notFound)).toBe(false);
  });

  it("maps every code to a plausible HTTP status", () => {
    for (const code of ERROR_CODE_VALUES) {
      const status = httpStatusForCode(code);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThanOrEqual(599);
      expect(Number.isInteger(status), code).toBe(true);
    }
    expect(httpStatusForCode(ERROR_CODES.notFound)).toBe(404);
    expect(httpStatusForCode(ERROR_CODES.conflict)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.authenticationFailed)).toBe(401);
    expect(httpStatusForCode(ERROR_CODES.authorizationFailed)).toBe(403);
    expect(httpStatusForCode(ERROR_CODES.timeout)).toBe(504);
    expect(httpStatusForCode(ERROR_CODES.notImplemented)).toBe(501);
  });
});

describe("OmnisError", () => {
  it("is a real Error with a stable name, code and timestamp", () => {
    const before = Date.now();
    const error = new OmnisError(ERROR_CODES.unknown, "something happened");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(OmnisError);
    expect(isOmnisError(error)).toBe(true);
    expect(error.name).toBe("OmnisError");
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("something happened");
    expect(tryParseIsoDateTime(error.occurredAt).ok).toBe(true);
    // Bracketed rather than compared against a second clock read: two reads inside the
    // same millisecond are indistinguishable, which makes an inequality assertion flaky.
    expect(Date.parse(error.occurredAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(error.occurredAt)).toBeLessThanOrEqual(Date.now());
  });

  it("redacts a credential interpolated into the message", () => {
    // The message is the one field of an error that cannot be dropped, and the one
    // most often built from whatever the failing call was holding.
    const error = new ProviderError("openai", `request failed with ${FAKE_SECRET}`);
    expect(error.message).toBe(`request failed with ${REDACTED}`);
    expect(error.toString()).not.toContain(FAKE_SECRET);
    expect(error.serialize().message).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(error)).not.toContain(FAKE_SECRET);
  });

  it("renders a single-line form carrying the code", () => {
    // A log line that omits the code forces every reader to guess the classification.
    expect(new OmnisError(ERROR_CODES.unknown, "boom").toString()).toBe(
      "OmnisError(unknown): boom",
    );
    expect(new NotFoundError("character", "chr_1").toString()).toBe(
      'NotFoundError(not_found): character "chr_1" was not found',
    );
  });

  it("redacts metadata at construction, not at serialization", () => {
    // Redacting only on the way out leaves the in-memory object holding a secret that
    // any debugger, inspector or later log line can read.
    const error = new OmnisError(ERROR_CODES.unknown, "failed", {
      metadata: { apiKey: FAKE_SECRET, tenantId: "ten_1" },
    });
    expect(error.metadata["apiKey"]).toBe(REDACTED);
    expect(error.metadata["tenantId"]).toBe("ten_1");
    expect(JSON.stringify(error)).not.toContain(FAKE_SECRET);
  });

  it("defaults metadata to an empty object", () => {
    expect(new OmnisError(ERROR_CODES.unknown, "x").metadata).toEqual({});
  });

  it("derives retryability from the code but honours an explicit override", () => {
    expect(new ProviderError("openai", "rate limited").retryable).toBe(true);
    // An invalid API key is a provider failure that retrying cannot fix.
    expect(new ProviderError("openai", "bad key", { retryable: false }).retryable).toBe(false);
    expect(new ValidationError("nope").retryable).toBe(false);
    expect(new ValidationError("nope", { retryable: true }).retryable).toBe(true);
  });

  it("carries a backoff hint when one is supplied", () => {
    const error = new TimeoutError("deadline", { retryAfterMs: 2500 });
    expect(error.retryAfterMs).toBe(2500);
    expect(error.serialize()["retryAfterMs"]).toBe(2500);
    // Absent rather than null: an optional field that is always present invites a
    // consumer to treat 0 as "retry immediately".
    expect("retryAfterMs" in new TimeoutError("deadline").serialize()).toBe(false);
  });

  it("preserves the standard cause", () => {
    const root = new Error("socket hang up");
    const error = new InfrastructureError("network", "upstream failed", { cause: root });
    expect(error.cause).toBe(root);
  });

  it("omits the stack unless explicitly requested", () => {
    const error = new ValidationError("nope");
    expect("stack" in error.serialize()).toBe(false);
    expect(error.serialize({ includeStack: true })["stack"]).toBeTruthy();
    // `toJSON` takes no parameters, so a stack can never leak through JSON.stringify:
    // the key it would receive is truthy, and a defaulted parameter would read it.
    expect("stack" in (JSON.parse(JSON.stringify(error)) as SerializedOmnisError)).toBe(false);
  });

  it("serializes a nested OMNIS cause and caps the chain depth", () => {
    const inner = new NotFoundError("character", "chr_1");
    const middle = new ExecutionError("step failed", { cause: inner });
    const outer = new InfrastructureError("pipeline", "run failed", { cause: middle });

    const serialized = outer.serialize();
    expect(serialized["cause"]).toBeTruthy();
    const cause = serialized["cause"] as SerializedOmnisError;
    expect(cause.code).toBe(ERROR_CODES.executionFailed);
    expect((cause["cause"] as SerializedOmnisError).code).toBe(ERROR_CODES.notFound);

    // A pathological chain must not produce an unbounded payload.
    expect(outer.serialize({ maxCauseDepth: 1 })["cause"]).toBeTruthy();
    const shallow = outer.serialize({ maxCauseDepth: 1 })["cause"] as SerializedOmnisError;
    expect("cause" in shallow).toBe(false);
    expect("cause" in outer.serialize({ maxCauseDepth: 0 })).toBe(false);
  });

  it("serializes a foreign cause by name and message, redacted", () => {
    const error = new ExecutionError("failed", { cause: new TypeError("bad shape") });
    expect(error.serialize()["cause"]).toEqual({ name: "TypeError", message: "bad shape" });

    const leaky = new ExecutionError("failed", { cause: new Error(`key ${FAKE_SECRET}`) });
    expect((leaky.serialize()["cause"] as { message: string }).message).toBe(`key ${REDACTED}`);
  });

  it("describes an unserializable cause instead of throwing", () => {
    const error = new ExecutionError("failed", { cause: Symbol("nope") });
    expect((error.serialize()["cause"] as { message: string }).message).toContain("symbol");
  });

  it("excludes the cause when there is none", () => {
    expect("cause" in new ValidationError("nope").serialize()).toBe(false);
  });
});

describe("the concrete hierarchy", () => {
  it("gives every class a distinct name and code", () => {
    const errors = oneOfEach();
    const names = errors.map((error) => error.name);
    expect(new Set(names).size).toBe(names.length);
    for (const error of errors) {
      // `constructor.name` is not stable under minification; the explicit assignment
      // is what makes the wire format trustworthy.
      expect(error.name, error.constructor.name).toBe(error.constructor.name);
      expect(isOmnisErrorCode(error.code), error.name).toBe(true);
      expect(isOmnisError(error), error.name).toBe(true);
      expect(error, error.name).toBeInstanceOf(OmnisError);
    }
  });

  it("classifies each subclass with the code its name implies", () => {
    expect(new ValidationError("x").code).toBe(ERROR_CODES.validationFailed);
    expect(new ConfigurationError("x").code).toBe(ERROR_CODES.configurationInvalid);
    expect(new NotFoundError("character").code).toBe(ERROR_CODES.notFound);
    expect(new ConflictError("dup", "x").code).toBe(ERROR_CODES.conflict);
    expect(new AuthenticationError("x").code).toBe(ERROR_CODES.authenticationFailed);
    expect(new AuthorizationError("x").code).toBe(ERROR_CODES.authorizationFailed);
    expect(new PolicyViolationError("p", "x").code).toBe(ERROR_CODES.policyViolation);
    expect(new ProviderError("openai", "x").code).toBe(ERROR_CODES.providerFailure);
    expect(new ExecutionError("x").code).toBe(ERROR_CODES.executionFailed);
    expect(new TimeoutError("x").code).toBe(ERROR_CODES.timeout);
    expect(new InfrastructureError("db", "x").code).toBe(ERROR_CODES.infrastructureFailure);
    expect(new ContractError("EventEnvelope", "x").code).toBe(ERROR_CODES.contractViolation);
    expect(new NotImplementedError("cap").code).toBe(ERROR_CODES.notImplemented);
  });

  it("keeps instanceof working for every subclass", () => {
    expect(new ValidationError("x")).toBeInstanceOf(ValidationError);
    expect(new ProviderError("openai", "x")).toBeInstanceOf(ProviderError);
    expect(new ProviderError("openai", "x")).not.toBeInstanceOf(ValidationError);
  });

  it("stores the class-specific detail that makes the error actionable", () => {
    const validation = new ValidationError("rejected", {
      issues: [{ path: "a.b", code: "invalid_type", message: "expected string", received: 42 }],
    });
    expect(validation.issues).toHaveLength(1);
    expect(validation.issues[0]?.path).toBe("a.b");

    const policy = new PolicyViolationError("policy.publish", "needs a human", {
      rule: "spend-cap",
      requiresApproval: true,
    });
    expect(policy.policyId).toBe("policy.publish");
    expect(policy.rule).toBe("spend-cap");
    expect(policy.requiresApproval).toBe(true);

    const provider = new ProviderError("youtube", "quota", {
      providerRef: "req_9",
      providerStatus: "403",
    });
    expect(provider.providerKind).toBe("youtube");
    expect(provider.providerRef).toBe("req_9");
    expect(provider.providerStatus).toBe("403");

    const timeout = new TimeoutError("deadline", { timeoutMs: 1500, operation: "transcode" });
    expect(timeout.timeoutMs).toBe(1500);
    expect(timeout.operation).toBe("transcode");

    const contract = new ContractError("EventEnvelope", "mismatch", {
      contractVersion: "1.0.0",
      receivedVersion: "2.0.0",
    });
    expect(contract.contractId).toBe("EventEnvelope");
    expect(contract.contractVersion).toBe("1.0.0");
    expect(contract.receivedVersion).toBe("2.0.0");

    const notImplemented = new NotImplementedError("video.render", { trackedIn: "ADR-0007" });
    expect(notImplemented.capability).toBe("video.render");
    expect(notImplemented.trackedIn).toBe("ADR-0007");
    // A deferred capability must say so explicitly rather than looking like a crash.
    expect(notImplemented.message).toContain("declared but not implemented");
    expect(notImplemented.retryable).toBe(false);

    expect(new NotFoundError("character", "chr_1").resourceType).toBe("character");
    expect(new NotFoundError("character", "chr_1").resourceId).toBe("chr_1");
    expect(new AuthorizationError("nope", { permission: "p" }).permission).toBe("p");
    expect(new ConfigurationError("nope", { keys: ["A", "B"] }).keys).toEqual(["A", "B"]);
    expect(new ConflictError("dup", "nope").conflict).toBe("dup");
    expect(new ExecutionError("nope", { executionId: "exe_2" }).executionId).toBe("exe_2");
    expect(new InfrastructureError("redis", "nope").component).toBe("redis");
    expect(new AuthenticationError("nope").retryable).toBe(false);
  });

  it("contributes class detail to the serialized metadata but not to the live object", () => {
    // The in-memory metadata stays exactly what the caller supplied, so there is one
    // unambiguous place to look while debugging; the wire form carries the extra
    // fields a remote consumer needs in order to act.
    const error = new PolicyViolationError("policy.publish", "needs a human", {
      rule: "spend-cap",
      requiresApproval: true,
      metadata: { tenantId: "ten_1" },
    });
    expect(error.metadata).toEqual({ tenantId: "ten_1" });
    expect(error.serialize().metadata).toEqual({
      tenantId: "ten_1",
      policyId: "policy.publish",
      rule: "spend-cap",
      requiresApproval: true,
    });
  });

  it("omits absent optional detail rather than emitting null", () => {
    // `null` asserts a value is known-absent; omitting the key says it is unknown.
    expect(new NotFoundError("character").serialize().metadata).toEqual({
      resourceType: "character",
    });
    expect(new TimeoutError("deadline").serialize().metadata).toEqual({});
    expect(new ValidationError("nope").serialize().metadata).toEqual({});
  });
});

describe("compactDetails", () => {
  it("drops undefined and keeps everything else, including null and false", () => {
    expect(compactDetails({ a: 1, b: undefined, c: null, d: false, e: "" })).toEqual({
      a: 1,
      c: null,
      d: false,
      e: "",
    });
    expect(compactDetails({})).toEqual({});
  });
});

describe("toOmnisError", () => {
  it("passes an existing OMNIS error through untouched", () => {
    const error = new ValidationError("nope");
    expect(toOmnisError(error)).toBe(error);
  });

  it("wraps a foreign Error, preserving its message and identity", () => {
    const foreign = new TypeError("bad shape");
    const wrapped = toOmnisError(foreign, { stage: "ingest" });
    expect(wrapped).toBeInstanceOf(OmnisError);
    expect(wrapped.code).toBe(ERROR_CODES.unknown);
    expect(wrapped.message).toBe("bad shape");
    expect(wrapped.cause).toBe(foreign);
    expect(wrapped.metadata).toEqual({ stage: "ingest" });
    expect(wrapped.retryable).toBe(false);
  });

  it("wraps a thrown string", () => {
    // `throw "nope"` is legal JavaScript and reaches catch blocks in real code.
    const wrapped = toOmnisError("nope");
    expect(wrapped.message).toBe("nope");
    expect(wrapped.cause).toBe("nope");
  });

  it("wraps an arbitrary thrown value without losing it", () => {
    const thrown = { code: 42 };
    const wrapped = toOmnisError(thrown);
    expect(wrapped.message).toBe("An unexpected non-error value was thrown");
    expect(wrapped.cause).toBe(thrown);
    expect(toOmnisError(null).message).toBe("An unexpected non-error value was thrown");
    expect(toOmnisError(undefined).cause).toBeUndefined();
  });

  it("redacts a secret supplied as context", () => {
    const wrapped = toOmnisError(new Error("failed"), { apiKey: FAKE_SECRET });
    expect(wrapped.metadata["apiKey"]).toBe(REDACTED);
  });

  it("recognises OMNIS errors thrown as unknown", () => {
    const error: unknown = new ProviderError("openai", "quota");
    expect(isOmnisError(error)).toBe(true);
    expect(toOmnisError(error)).toBe(error);
    expect(isOmnisError(new Error("plain"))).toBe(false);
    expect(isOmnisError("text")).toBe(false);
    expect(isOmnisError(null)).toBe(false);
  });
});

describe("serialization round-trip", () => {
  it.each(oneOfEach().map((error) => [error.name, error] as const))(
    "rebuilds %s with its classification, detail and retryability",
    (_name, error) => {
      // Through JSON, not just through the object: this is the path a queue and an
      // HTTP client actually take.
      const wire = JSON.parse(JSON.stringify(error)) as SerializedOmnisError;
      const rebuilt = omnisErrorFromSerialized(wire);

      expect(rebuilt).toBeInstanceOf(OmnisError);
      expect(rebuilt.name).toBe(error.name);
      expect(rebuilt.code).toBe(error.code);
      expect(rebuilt.message).toBe(error.message);
      expect(rebuilt.retryable).toBe(error.retryable);
      expect(rebuilt.retryAfterMs).toBe(error.retryAfterMs);
      expect(rebuilt.metadata).toEqual(wire.metadata);
    },
  );

  it("restores the class-specific fields a consumer branches on", () => {
    const validation = new ValidationError("rejected", {
      issues: [{ path: "title", code: "too_small", message: "required", received: null }],
    });
    const rebuiltValidation = omnisErrorFromSerialized(
      JSON.parse(JSON.stringify(validation)) as SerializedOmnisError,
    );
    expect(rebuiltValidation).toBeInstanceOf(ValidationError);
    expect((rebuiltValidation as ValidationError).issues).toEqual(validation.issues);

    const policy = new PolicyViolationError("policy.publish", "needs a human", {
      rule: "spend-cap",
      requiresApproval: true,
    });
    const rebuiltPolicy = omnisErrorFromSerialized(
      JSON.parse(JSON.stringify(policy)) as SerializedOmnisError,
    ) as PolicyViolationError;
    expect(rebuiltPolicy.policyId).toBe("policy.publish");
    expect(rebuiltPolicy.rule).toBe("spend-cap");
    expect(rebuiltPolicy.requiresApproval).toBe(true);

    const provider = new ProviderError("youtube", "quota", {
      providerRef: "req_9",
      providerStatus: "403",
    });
    const rebuiltProvider = omnisErrorFromSerialized(
      JSON.parse(JSON.stringify(provider)) as SerializedOmnisError,
    ) as ProviderError;
    expect(rebuiltProvider.providerKind).toBe("youtube");
    expect(rebuiltProvider.providerRef).toBe("req_9");
    expect(rebuiltProvider.providerStatus).toBe("403");

    const timeout = new TimeoutError("deadline", { timeoutMs: 1500, operation: "transcode" });
    const rebuiltTimeout = omnisErrorFromSerialized(
      JSON.parse(JSON.stringify(timeout)) as SerializedOmnisError,
    ) as TimeoutError;
    expect(rebuiltTimeout.timeoutMs).toBe(1500);
    expect(rebuiltTimeout.operation).toBe("transcode");

    const notFound = new NotFoundError("character", "chr_1");
    const rebuiltNotFound = omnisErrorFromSerialized(
      JSON.parse(JSON.stringify(notFound)) as SerializedOmnisError,
    ) as NotFoundError;
    expect(rebuiltNotFound.resourceType).toBe("character");
    expect(rebuiltNotFound.resourceId).toBe("chr_1");
  });

  it("falls back to a plain OmnisError for a code it does not specialise", () => {
    const wire: SerializedOmnisError = {
      name: "OmnisError",
      code: ERROR_CODES.unknown,
      message: "unclassified",
      metadata: {},
      retryable: false,
      occurredAt: nowIso(),
    };
    const rebuilt = omnisErrorFromSerialized(wire);
    expect(rebuilt).toBeInstanceOf(OmnisError);
    expect(rebuilt.code).toBe(ERROR_CODES.unknown);
  });

  it("does not trust a code from an unrecognised producer", () => {
    // A newer producer may emit a code this build has never seen. Adopting it would
    // put an invalid value into a typed field and break every consumer that switches
    // on it; `unknown` keeps the message and metadata while staying inside the
    // vocabulary.
    const wire = {
      name: "FutureError",
      code: "quantum_decoherence",
      message: "from a newer build",
      metadata: {},
      retryable: true,
      occurredAt: nowIso(),
    } as unknown as SerializedOmnisError;
    const rebuilt = omnisErrorFromSerialized(wire);
    expect(rebuilt.code).toBe(ERROR_CODES.unknown);
    expect(rebuilt.message).toBe("from a newer build");
    expect(rebuilt.retryable).toBe(true);
  });

  it("tolerates metadata that does not carry the expected detail", () => {
    const wire: SerializedOmnisError = {
      name: "NotFoundError",
      code: ERROR_CODES.notFound,
      message: "gone",
      metadata: { resourceType: 42 as unknown as string },
      retryable: false,
      occurredAt: nowIso(),
    };
    const rebuilt = omnisErrorFromSerialized(wire) as NotFoundError;
    expect(rebuilt).toBeInstanceOf(NotFoundError);
    expect(rebuilt.resourceType).toBe("resource");
    expect(rebuilt.resourceId).toBeUndefined();
  });

  it("never carries a secret across the boundary", () => {
    const error = new ProviderError("openai", `failed with ${FAKE_SECRET}`, {
      metadata: { clientSecret: FAKE_SECRET, tenantId: "ten_1" },
      cause: new Error(FAKE_SECRET),
    });
    const wire = JSON.stringify(error);
    expect(wire).not.toContain(FAKE_SECRET);
    expect(wire).toContain(REDACTED);
    expect(omnisErrorFromSerialized(JSON.parse(wire) as SerializedOmnisError).message).toBe(
      error.message,
    );
  });
});
