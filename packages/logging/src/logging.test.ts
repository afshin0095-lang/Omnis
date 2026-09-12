/**
 * Logging tests.
 *
 * Three properties are worth testing here, because each one fails silently in
 * production if it is wrong:
 *
 * 1. **Level filtering happens before formatting.** A dropped record must cost nothing,
 *    and a record that should have been emitted must not be lost.
 * 2. **Context inheritance is field-by-field.** `logger.child({...})` is how a
 *    correlation id reaches every line of a request; a merge that silently drops a
 *    field shows up only as untraceable logs.
 * 3. **Nothing secret reaches a sink.** Attributes and errors are redacted on the way
 *    into the record, so no sink — present or future — has to remember to do it.
 */

import { ProviderError, ValidationError } from "@omnis/errors";
import {
  asCausationId,
  createCorrelationId,
  createEventId,
  createExecutionId,
  createTenantId,
  LOG_LEVELS,
  parseIsoDateTime,
  parseTrimmedString,
} from "@omnis/types";
import type { LogLevel } from "@omnis/types";
import { describe, expect, it, vi } from "vitest";
import {
  buildLogRecord,
  ConsoleLogSink,
  createLogger,
  isNoopLogger,
  MemoryLogSink,
  mergeLogContext,
  NOOP_LOGGER,
  renderJson,
  renderPretty,
  StandardLogger,
} from "./index.js";
import type { LogRecord, LogSink } from "./index.js";

/** A fictitious credential: correct shape, wrong secret. */
const FAKE_SECRET = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"; // omnis-secret-scan:allow fictitious key: proves log records redact on emit

/** A sink that records what it was handed. */
function collectingSink(): { sink: LogSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: { write: (record) => void records.push(record) }, records };
}

/** A minimal record, for the renderer tests. */
function sampleRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    // Minted through the parser rather than written as a literal: `timestamp` is a
    // branded UtcTimestamp, and the brand is what stops an arbitrary string being
    // passed off as an instant.
    timestamp: parseIsoDateTime("2026-09-11T12:00:00.000Z"),
    level: "info",
    message: "character published",
    service: parseTrimmedString("content-factory"),
    environment: "production",
    executionId: null,
    correlationId: null,
    causationId: null,
    tenantId: null,
    actorId: null,
    characterId: null,
    agentId: null,
    contentId: null,
    attributes: {},
    error: null,
    ...overrides,
  };
}

describe("createLogger", () => {
  it("defaults to info and to discarding records", () => {
    const logger = createLogger();
    expect(logger).toBeInstanceOf(StandardLogger);
    expect((logger as StandardLogger).level).toBe("info");
    // No sink means no output and no throw: a logger constructed without wiring must
    // still be safe to call.
    expect(() => logger.info("dropped")).not.toThrow();
  });

  it("emits at and above the configured level", () => {
    const { sink, records } = collectingSink();
    const logger = createLogger({ level: "warn", sink });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(records.map((record) => record.level)).toEqual(["warn", "error"]);
  });

  it("emits everything at debug", () => {
    const { sink, records } = collectingSink();
    const logger = createLogger({ level: "debug", sink });
    for (const level of LOG_LEVELS) {
      logger[level]("message");
    }
    expect(records.map((record) => record.level)).toEqual([...LOG_LEVELS]);
  });

  it("emits nothing at error except errors", () => {
    const { sink, records } = collectingSink();
    const logger = createLogger({ level: "error", sink });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(records).toHaveLength(1);
  });

  it("filters before formatting", () => {
    // A record dropped by the threshold must not be built at all: redaction,
    // serialization and attribute copying are the expensive part of logging, and a
    // debug line in a production process should cost close to nothing.
    const write = vi.fn();
    const logger = createLogger({ level: "error", sink: { write } });
    logger.debug("expensive", { attributes: { a: 1 }, correlationId: createCorrelationId() });
    expect(write).not.toHaveBeenCalled();
  });

  it("derives a logger at a different level without disturbing the original", () => {
    const { sink, records } = collectingSink();
    const logger = createLogger({
      level: "info",
      sink,
      context: { service: parseTrimmedString("svc") },
    });
    const quiet = logger.withLevel("error");
    quiet.info("dropped");
    quiet.error("kept");
    logger.info("also kept");
    expect(records.map((record) => record.message)).toEqual(["kept", "also kept"]);
    expect((logger as StandardLogger).level).toBe("info");
  });
});

describe("child loggers", () => {
  it("carries the parent's bindings into every record", () => {
    const { sink, records } = collectingSink();
    const correlationId = createCorrelationId();
    const tenantId = createTenantId();
    const logger = createLogger({ level: "debug", sink }).child({ correlationId, tenantId });

    logger.info("first");
    logger.info("second");

    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.correlationId).toBe(String(correlationId));
      expect(record.tenantId).toBe(String(tenantId));
    }
  });

  it("lets a call override one bound field without losing the others", () => {
    const { sink, records } = collectingSink();
    const correlationId = createCorrelationId();
    const executionId = createExecutionId();
    const logger = createLogger({ level: "debug", sink }).child({ correlationId });

    logger.info("with execution", { executionId });

    expect(records[0]?.correlationId).toBe(String(correlationId));
    expect(records[0]?.executionId).toBe(String(executionId));
  });

  it("nests, with the innermost binding winning", () => {
    const { sink, records } = collectingSink();
    const root = createLogger({
      level: "debug",
      sink,
      context: { service: parseTrimmedString("root") },
    });
    const child = root.child({ service: parseTrimmedString("child"), actorId: "usr_1" });
    const grandchild = child.child({ service: parseTrimmedString("grandchild") });

    grandchild.info("deep");

    expect(records[0]?.service).toBe("grandchild");
    expect(records[0]?.actorId).toBe("usr_1");
  });

  it("shares the parent's sink", () => {
    const { sink, records } = collectingSink();
    const parent = createLogger({ sink });
    parent.child({}).info("from child");
    expect(records).toHaveLength(1);
  });

  it("does not mutate the parent's bindings", () => {
    const { sink, records } = collectingSink();
    const parent = createLogger({ level: "debug", sink, context: { actorId: "usr_parent" } });
    const child = parent.child({ actorId: "usr_child" });
    child.info("child line");
    parent.info("parent line");
    expect(records.map((record) => record.actorId)).toEqual(["usr_child", "usr_parent"]);
  });
});

describe("mergeLogContext", () => {
  it("lets the overlay win field by field", () => {
    const merged = mergeLogContext(
      { service: parseTrimmedString("a"), actorId: "usr_1", tenantId: createTenantId() },
      { service: parseTrimmedString("b") },
    );
    expect(merged.service).toBe("b");
    expect(merged.actorId).toBe("usr_1");
    expect(merged.tenantId).toBeTruthy();
  });

  it("merges attribute bags rather than replacing them", () => {
    const merged = mergeLogContext(
      { attributes: { a: 1, shared: "base" } },
      { attributes: { b: 2, shared: "overlay" } },
    );
    expect(merged.attributes).toEqual({ a: 1, b: 2, shared: "overlay" });
  });

  it("leaves attributes absent when neither side has any", () => {
    // An empty object and an absent bag render differently in a structured log, and
    // inventing one where the caller supplied none adds noise to every line.
    expect(mergeLogContext({}, {}).attributes).toBeUndefined();
    expect(mergeLogContext({ attributes: { a: 1 } }, {}).attributes).toEqual({ a: 1 });
  });

  it("merges every field the context declares", () => {
    // This is the drift guard: mergeLogContext is written out field by field so that
    // adding a field to LogContext fails to compile until the merge is updated. A
    // spread would silently drop it, and the symptom would be a correlation id missing
    // from some log lines and nothing else.
    const tenantId = createTenantId();
    const full = mergeLogContext(
      {},
      {
        service: parseTrimmedString("svc"),
        environment: "production",
        executionId: createExecutionId(),
        correlationId: createCorrelationId(),
        causationId: asCausationId(createEventId()),
        tenantId,
        actorId: "usr_1",
        characterId: undefined,
        agentId: undefined,
        contentId: undefined,
        error: new Error("x"),
        attributes: { a: 1 },
      },
    );
    expect(full.service).toBe("svc");
    expect(full.environment).toBe("production");
    expect(full.executionId).toBeTruthy();
    expect(full.correlationId).toBeTruthy();
    expect(full.causationId).toBeTruthy();
    expect(full.tenantId).toBe(tenantId);
    expect(full.actorId).toBe("usr_1");
    expect(full.error).toBeInstanceOf(Error);
    expect(full.attributes).toEqual({ a: 1 });
  });
});

describe("buildLogRecord", () => {
  it("nulls every field the caller did not supply", () => {
    const record = buildLogRecord("info", "hello", {});
    expect(record.level).toBe("info");
    expect(record.message).toBe("hello");
    expect(record.service).toBeNull();
    expect(record.environment).toBeNull();
    expect(record.tenantId).toBeNull();
    expect(record.correlationId).toBeNull();
    expect(record.error).toBeNull();
    expect(record.attributes).toEqual({});
    expect(record.timestamp).toMatch(/Z$/);
  });

  it("renders branded identifiers as plain strings", () => {
    // Every sink sees the same shape, so no sink has to know that a TenantId is a
    // branded string rather than a string.
    const tenantId = createTenantId();
    const record = buildLogRecord("info", "x", { tenantId });
    expect(record.tenantId).toBe(String(tenantId));
    expect(typeof record.tenantId).toBe("string");
  });

  it("redacts attributes on the way into the record", () => {
    const record = buildLogRecord("info", "x", {
      attributes: { apiKey: FAKE_SECRET, tenantId: "ten_1", nested: { token: FAKE_SECRET } },
    });
    expect(JSON.stringify(record)).not.toContain(FAKE_SECRET);
    expect(record.attributes["apiKey"]).toBe("[REDACTED]");
    expect(record.attributes["tenantId"]).toBe("ten_1");
  });

  it("serializes an OMNIS error with its classification", () => {
    const error = new ValidationError("rejected", {
      issues: [{ path: "title", code: "too_small", message: "required", received: null }],
    });
    const record = buildLogRecord("error", "validation failed", { error });
    expect(record.error).not.toBeNull();
    expect(record.error?.["code"]).toBe("validation_failed");
    expect(record.error?.["name"]).toBe("ValidationError");
    expect(record.error?.["message"]).toBe("rejected");
    // Class-specific detail travels inside `metadata`, which is where the error
    // hierarchy puts it; a consumer that looked for it at the top level would find
    // nothing and report "validation failed" with no indication of what failed.
    const metadata = record.error?.["metadata"] as Record<string, unknown> | undefined;
    expect(Array.isArray(metadata?.["issues"])).toBe(true);
    expect((metadata?.["issues"] as readonly unknown[])[0]).toEqual({
      path: "title",
      code: "too_small",
      message: "required",
      received: null,
    });
    expect(record.error?.["retryable"]).toBe(false);
    expect(record.error?.["occurredAt"]).toBeTruthy();
  });

  it("serializes a foreign error by name and message", () => {
    const record = buildLogRecord("error", "failed", { error: new TypeError("bad shape") });
    expect(record.error).toEqual({ name: "TypeError", message: "bad shape" });
  });

  it("records a thrown non-error instead of dropping it", () => {
    // Anything can be thrown in JavaScript, and a swallowed value is an undiagnosable
    // incident.
    expect(buildLogRecord("error", "failed", { error: "nope" }).error).toEqual({
      message: "nope",
    });
    expect(buildLogRecord("error", "failed", { error: 42 }).error).toEqual({ message: "42" });
    expect(buildLogRecord("error", "failed", { error: null }).error).toBeNull();
    expect(buildLogRecord("error", "failed", { error: undefined }).error).toBeNull();
  });

  it("redacts a credential carried by the error", () => {
    const error = new ProviderError("openai", `request failed with ${FAKE_SECRET}`, {
      metadata: { clientSecret: FAKE_SECRET },
    });
    const rendered = JSON.stringify(buildLogRecord("error", "failed", { error }));
    expect(rendered).not.toContain(FAKE_SECRET);
    expect(rendered).toContain("[REDACTED]");
  });

  it("omits the stack unless explicitly asked for", () => {
    const error = new ValidationError("rejected");
    expect(buildLogRecord("error", "failed", { error }).error?.["stack"]).toBeUndefined();
    expect(buildLogRecord("error", "failed", { error }, true).error?.["stack"]).toBeTruthy();
  });
});

describe("resilience", () => {
  it("does not let a throwing sink take down the caller", () => {
    // Logging is a side concern. Losing a record is acceptable; crashing a production
    // request because a log transport was briefly unavailable is not.
    const sink: LogSink = {
      write: () => {
        throw new Error("transport down");
      },
    };
    const logger = createLogger({ level: "debug", sink });
    expect(() => logger.error("must not throw")).not.toThrow();
  });
});

describe("renderJson", () => {
  it("produces a single parseable line", () => {
    const line = renderJson(sampleRecord());
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toBeTruthy();
  });

  it("drops null and empty-object fields", () => {
    // Eleven nulls per line multiplies storage and aggregator cost for no information.
    const parsed = JSON.parse(renderJson(sampleRecord())) as Record<string, unknown>;
    expect("tenantId" in parsed).toBe(false);
    expect("error" in parsed).toBe(false);
    expect("attributes" in parsed).toBe(false);
    expect(parsed["level"]).toBe("info");
    expect(parsed["message"]).toBe("character published");
  });

  it("keeps fields that are present", () => {
    const parsed = JSON.parse(
      renderJson(sampleRecord({ tenantId: "ten_1", attributes: { a: 1 } })),
    ) as Record<string, unknown>;
    expect(parsed["tenantId"]).toBe("ten_1");
    expect(parsed["attributes"]).toEqual({ a: 1 });
  });
});

describe("renderPretty", () => {
  it("renders timestamp, level, scope, message and identifiers", () => {
    const line = renderPretty(
      sampleRecord({ correlationId: "cor_1", tenantId: "ten_1", executionId: "exe_1" }),
    );
    expect(line).toContain("2026-09-11T12:00:00.000Z");
    expect(line).toContain("INFO ");
    expect(line).toContain("[content-factory production]");
    expect(line).toContain("character published");
    expect(line).toContain("{correlationId=cor_1 tenantId=ten_1 executionId=exe_1}");
  });

  it("omits the scope and identifier brackets when they are empty", () => {
    const line = renderPretty(sampleRecord({ service: null, environment: null }));
    expect(line).not.toContain("[");
    expect(line).not.toContain("{");
    expect(line).toBe("2026-09-11T12:00:00.000Z INFO  character published");
  });

  it("pads the level so columns line up", () => {
    expect(renderPretty(sampleRecord({ level: "info" }))).toContain("INFO ");
    expect(renderPretty(sampleRecord({ level: "error" }))).toContain("ERROR");
    expect(renderPretty(sampleRecord({ level: "debug" }))).toContain("DEBUG");
  });

  it("appends the error on a second line with its code", () => {
    const line = renderPretty(
      sampleRecord({ level: "error", error: { code: "not_found", message: "gone" } }),
    );
    expect(line.split("\n")).toHaveLength(2);
    expect(line).toContain("error (not_found): gone");
  });

  it("appends an error that carries no code", () => {
    const line = renderPretty(sampleRecord({ error: { message: "gone" } }));
    expect(line).toContain("error: gone");
    expect(line).not.toContain("()");
  });
});

describe("ConsoleLogSink", () => {
  it("writes one line per record to the injected console", () => {
    const log = vi.fn();
    const error = vi.fn();
    const sink = new ConsoleLogSink({ console: { log, error } });

    sink.write(sampleRecord({ level: "info" }));
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toBeTruthy();
  });

  it("sends warnings and errors to stderr", () => {
    // Separating diagnostics from data output lets a supervisor or a shell redirect
    // handle them differently, without the sink knowing anything about either.
    const log = vi.fn();
    const error = vi.fn();
    const sink = new ConsoleLogSink({ console: { log, error } });

    sink.write(sampleRecord({ level: "warn" }));
    sink.write(sampleRecord({ level: "error" }));
    sink.write(sampleRecord({ level: "debug" }));

    expect(error).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("renders pretty when asked", () => {
    const log = vi.fn();
    const sink = new ConsoleLogSink({ format: "pretty", console: { log, error: vi.fn() } });
    sink.write(sampleRecord());
    const line = log.mock.calls[0]?.[0] as string;
    expect(line).toContain("INFO");
    expect(() => JSON.parse(line)).toThrow();
  });

  it("defaults to json", () => {
    const log = vi.fn();
    const sink = new ConsoleLogSink({ console: { log, error: vi.fn() } });
    sink.write(sampleRecord());
    expect(() => JSON.parse(log.mock.calls[0]?.[0] as string)).not.toThrow();
  });
});

describe("MemoryLogSink", () => {
  it("retains records oldest first", () => {
    const sink = new MemoryLogSink();
    sink.write(sampleRecord({ message: "first" }));
    sink.write(sampleRecord({ message: "second" }));
    expect(sink.length).toBe(2);
    expect(sink.all().map((record) => record.message)).toEqual(["first", "second"]);
  });

  it("is bounded, dropping the oldest when full", () => {
    // An unbounded in-memory sink in a long-running process is a memory leak wearing a
    // debugging hat.
    const sink = new MemoryLogSink(3);
    for (let index = 0; index < 10; index += 1) {
      sink.write(sampleRecord({ message: `m${index}` }));
    }
    expect(sink.length).toBe(3);
    expect(sink.all().map((record) => record.message)).toEqual(["m7", "m8", "m9"]);
  });

  it("rejects a capacity that cannot hold anything", () => {
    expect(() => new MemoryLogSink(0)).toThrow(RangeError);
    expect(() => new MemoryLogSink(-1)).toThrow(RangeError);
    expect(() => new MemoryLogSink(1.5)).toThrow(RangeError);
    expect(() => new MemoryLogSink(Number.NaN)).toThrow(RangeError);
  });

  it("filters by severity", () => {
    const sink = new MemoryLogSink();
    for (const level of LOG_LEVELS) {
      sink.write(sampleRecord({ level: level as LogLevel }));
    }
    expect(sink.atLevel("warn").map((record) => record.level)).toEqual(["warn", "error"]);
    expect(sink.atLevel("error")).toHaveLength(1);
    expect(sink.atLevel("debug")).toHaveLength(LOG_LEVELS.length);
  });

  it("filters by message fragment and clears", () => {
    const sink = new MemoryLogSink();
    sink.write(sampleRecord({ message: "character published" }));
    sink.write(sampleRecord({ message: "character deleted" }));
    expect(sink.matching("published")).toHaveLength(1);
    expect(sink.matching("character")).toHaveLength(2);
    expect(sink.matching("nothing")).toHaveLength(0);

    sink.clear();
    expect(sink.length).toBe(0);
    expect(sink.all()).toEqual([]);
  });
});

describe("NOOP_LOGGER", () => {
  it("accepts every call and produces nothing", () => {
    const write = vi.fn();
    // A no-op logger must still be a Logger, so a caller cannot tell the difference
    // except by the absence of output.
    expect(isNoopLogger(NOOP_LOGGER)).toBe(true);
    expect(() => {
      for (const level of LOG_LEVELS) {
        NOOP_LOGGER[level]("message", { attributes: { a: 1 } });
      }
    }).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("returns a no-op from child and withLevel", () => {
    expect(isNoopLogger(NOOP_LOGGER.child({ actorId: "usr_1" }))).toBe(true);
    expect(isNoopLogger(NOOP_LOGGER.withLevel("debug"))).toBe(true);
    expect(NOOP_LOGGER.child({}).child({})).toBe(NOOP_LOGGER);
  });

  it("does not mistake a real logger for a no-op", () => {
    const { sink } = collectingSink();
    expect(isNoopLogger(createLogger({ sink }))).toBe(false);
    expect(isNoopLogger(NOOP_LOGGER.withLevel("error"))).toBe(true);
  });
});

describe("end to end", () => {
  it("carries a request's correlation id from a child logger into a rendered line", () => {
    const sink = new MemoryLogSink();
    const correlationId = createCorrelationId();
    const tenantId = createTenantId();
    const logger = createLogger({
      level: "debug",
      sink,
      context: { service: parseTrimmedString("content-factory"), environment: "production" },
    }).child({ correlationId, tenantId });

    logger.info("production started", { executionId: createExecutionId() });
    logger.error("production failed", { error: new ValidationError("rejected") });

    expect(sink.length).toBe(2);
    const [first, second] = sink.all();
    expect(first?.correlationId).toBe(String(correlationId));
    expect(first?.tenantId).toBe(String(tenantId));
    expect(second?.error?.["code"]).toBe("validation_failed");

    const pretty = renderPretty(first as LogRecord);
    expect(pretty).toContain(`correlationId=${String(correlationId)}`);
    expect(pretty).toContain("[content-factory production]");

    const json = JSON.parse(renderJson(second as LogRecord)) as Record<string, unknown>;
    expect(json["level"]).toBe("error");
    expect(json["error"]).toBeTruthy();
  });
});
