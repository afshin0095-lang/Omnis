/**
 * Shared vocabulary tests.
 *
 * These are the small closed sets the whole platform agrees on: event namespaces, log
 * levels, environments, social platforms. Each one is a wire contract — a value here
 * appears in event types, log records, configuration and analytics attribution — so
 * the interesting assertions are about what is *rejected* and about the sets staying
 * complete as the domain grows.
 */

import { describe, expect, it } from "vitest";
import {
  ENVIRONMENTS,
  EVENT_NAMESPACES,
  eventNamespaceOf,
  eventTypeSegments,
  InvalidValueError,
  isCommandName,
  isEnvironmentName,
  isEventType,
  isLogFormat,
  isLogLevel,
  isNonProduction,
  isProduction,
  isSocialPlatform,
  LOG_FORMATS,
  LOG_LEVELS,
  logLevelSeverity,
  normaliseEnvironmentName,
  normaliseLogLevel,
  normaliseSocialPlatform,
  parseCommandName,
  parseEventType,
  PLANNED_SOCIAL_PLATFORMS,
  shouldLog,
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_PLATFORMS,
  tryParseCommandName,
  tryParseEventType,
} from "./index.js";

describe("event types", () => {
  it("accepts lowercase dotted names of at least two segments", () => {
    expect(parseEventType("character.created")).toBe("character.created");
    expect(parseEventType("content.production.completed")).toBe("content.production.completed");
    expect(parseEventType("agent.execution.failed")).toBe("agent.execution.failed");
    expect(parseEventType("analytics.engagement.rate.computed")).toBe(
      "analytics.engagement.rate.computed",
    );
  });

  it("accepts digits inside a segment", () => {
    expect(isEventType("publishing.v2.scheduled")).toBe(true);
    expect(isEventType("content.short60.rendered")).toBe(true);
  });

  it("rejects names that are not valid event types", () => {
    const invalid = [
      "", // empty
      "charactercreated", // single segment: no owning namespace
      "Character.Created", // uppercase
      "character.created.", // trailing dot
      ".character.created", // leading dot
      "character..created", // empty segment
      "character.Created", // mixed case
      "character-created", // wrong separator
      "9character.created", // segment must start with a letter
      "character.créated", // non-ASCII
      42, // not a string
      null,
      undefined,
      ["character.created"],
    ];
    for (const value of invalid) {
      expect(isEventType(value), String(value)).toBe(false);
      expect(tryParseEventType(value).ok, String(value)).toBe(false);
    }
  });

  it("rejects names longer than the wire limit", () => {
    const long = `character.${"a".repeat(130)}`;
    const result = tryParseEventType(long);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("128 characters");
    }
  });

  it("throws InvalidValueError echoing the rejected name", () => {
    let thrown: unknown;
    try {
      parseEventType("Character.Created");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidValueError);
    const failure = thrown as InvalidValueError;
    expect(failure.type).toBe("EventType");
    expect(failure.message).toContain("Character.Created");
    expect(failure.message).toContain("lowercase dotted name");
  });

  it("reports the owning namespace", () => {
    // The namespace is how event ownership is visible on the wire; the registry uses
    // it to reject an event published by a domain that does not own it.
    for (const namespace of EVENT_NAMESPACES) {
      expect(eventNamespaceOf(parseEventType(`${namespace}.something.happened`))).toBe(namespace);
    }
  });

  it("returns null for a namespace the platform does not recognise", () => {
    expect(eventNamespaceOf(parseEventType("billing.invoice.paid"))).toBeNull();
    expect(eventNamespaceOf(parseEventType("unknown.thing.done"))).toBeNull();
  });

  it("declares the eight domain namespaces", () => {
    expect(EVENT_NAMESPACES).toEqual([
      "system",
      "agent",
      "character",
      "audience",
      "content",
      "publishing",
      "analytics",
      // Added in Sprint 1: the AI Core execution substrate. Appended rather than
      // inserted, so the ordering of the seven Sprint 0 namespaces stays stable.
      "ai",
    ]);
    expect(new Set(EVENT_NAMESPACES).size).toBe(EVENT_NAMESPACES.length);
  });

  it("splits an event type into its segments", () => {
    expect(eventTypeSegments(parseEventType("content.production.completed"))).toEqual([
      "content",
      "production",
      "completed",
    ]);
  });
});

describe("command names", () => {
  it("uses the same grammar as event types", () => {
    expect(parseCommandName("content.production.start")).toBe("content.production.start");
    expect(isCommandName("publishing.schedule.submit")).toBe(true);
  });

  it("rejects the same malformed shapes", () => {
    for (const value of ["", "start", "Content.Production.Start", "content..start", 7]) {
      expect(isCommandName(value), String(value)).toBe(false);
    }
  });

  it("throws InvalidValueError naming the type", () => {
    let thrown: unknown;
    try {
      parseCommandName("nope");
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as InvalidValueError;
    expect(failure.type).toBe("CommandName");
    expect(failure.message).toContain("content.production.start");
  });

  it("rejects an over-long name", () => {
    expect(tryParseCommandName(`a.${"b".repeat(200)}`).ok).toBe(false);
  });
});

describe("log levels", () => {
  it("declares four levels in ascending severity", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
    const severities = LOG_LEVELS.map((level) => logLevelSeverity(level));
    expect([...severities].sort((a, b) => a - b)).toEqual(severities);
    expect(new Set(severities).size).toBe(severities.length);
  });

  it("recognises its own levels and formats", () => {
    for (const level of LOG_LEVELS) {
      expect(isLogLevel(level)).toBe(true);
    }
    expect(isLogLevel("trace")).toBe(false);
    expect(isLogLevel("ERROR")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);

    expect(LOG_FORMATS).toEqual(["json", "pretty"]);
    expect(isLogFormat("json")).toBe(true);
    expect(isLogFormat("text")).toBe(false);
  });

  it("gates on the threshold inclusively", () => {
    // `warn` at a `warn` threshold must be emitted: an exclusive comparison would
    // silently drop the first level an operator actually configured to see.
    expect(shouldLog("warn", "warn")).toBe(true);
    expect(shouldLog("error", "warn")).toBe(true);
    expect(shouldLog("info", "warn")).toBe(false);
    expect(shouldLog("debug", "info")).toBe(false);
    expect(shouldLog("debug", "debug")).toBe(true);
    expect(shouldLog("error", "error")).toBe(true);
  });

  it("normalises the conventional aliases operators actually set", () => {
    expect(normaliseLogLevel("INFO")).toBe("info");
    expect(normaliseLogLevel("information")).toBe("info");
    expect(normaliseLogLevel("notice")).toBe("info");
    expect(normaliseLogLevel(" Warn ")).toBe("warn");
    expect(normaliseLogLevel("WARNING")).toBe("warn");
    expect(normaliseLogLevel("verbose")).toBe("debug");
    expect(normaliseLogLevel("trace")).toBe("debug");
    expect(normaliseLogLevel("fatal")).toBe("error");
    expect(normaliseLogLevel("critical")).toBe("error");
    expect(normaliseLogLevel("severe")).toBe("error");
  });

  it("returns null for a level it does not recognise", () => {
    // A silent fallback would leave a service logging at the wrong volume, which in
    // production is a cost and a confidentiality incident rather than an annoyance.
    expect(normaliseLogLevel("ERR")).toBeNull();
    expect(normaliseLogLevel("chatty")).toBeNull();
    expect(normaliseLogLevel("")).toBeNull();
    expect(normaliseLogLevel(3)).toBeNull();
    expect(normaliseLogLevel(undefined)).toBeNull();
    expect(normaliseLogLevel(null)).toBeNull();
  });
});

describe("environments", () => {
  it("declares the four deployment environments", () => {
    expect(ENVIRONMENTS).toEqual(["development", "test", "staging", "production"]);
    for (const environment of ENVIRONMENTS) {
      expect(isEnvironmentName(environment)).toBe(true);
    }
  });

  it("rejects values that are not environments", () => {
    expect(isEnvironmentName("prod")).toBe(false);
    expect(isEnvironmentName("PRODUCTION")).toBe(false);
    expect(isEnvironmentName("")).toBe(false);
    expect(isEnvironmentName(null)).toBe(false);
  });

  it("normalises the abbreviations and casings the shell actually uses", () => {
    expect(normaliseEnvironmentName("dev")).toBe("development");
    expect(normaliseEnvironmentName("LOCAL")).toBe("development");
    expect(normaliseEnvironmentName("  Development ")).toBe("development");
    expect(normaliseEnvironmentName("ci")).toBe("test");
    expect(normaliseEnvironmentName("TESTING")).toBe("test");
    expect(normaliseEnvironmentName("preprod")).toBe("staging");
    expect(normaliseEnvironmentName("uat")).toBe("staging");
    expect(normaliseEnvironmentName("stage")).toBe("staging");
    expect(normaliseEnvironmentName("PROD")).toBe("production");
    expect(normaliseEnvironmentName("live")).toBe("production");
  });

  it("refuses to guess for an unrecognised value", () => {
    // Defaulting to development would disable production fail-fast checks; defaulting
    // to production would enable real side effects during a test run. Both are worse
    // than refusing to start.
    expect(normaliseEnvironmentName("banana")).toBeNull();
    expect(normaliseEnvironmentName("")).toBeNull();
    expect(normaliseEnvironmentName(undefined)).toBeNull();
    expect(normaliseEnvironmentName(1)).toBeNull();
  });

  it("identifies production exactly", () => {
    expect(isProduction("production")).toBe(true);
    expect(isProduction("staging")).toBe(false);
    expect(isNonProduction("staging")).toBe(true);
    expect(isNonProduction("production")).toBe(false);
    // Every environment is in exactly one of the two sets.
    for (const environment of ENVIRONMENTS) {
      expect(isProduction(environment) !== isNonProduction(environment), environment).toBe(true);
    }
  });
});

describe("social platforms", () => {
  it("declares the supported platforms and their labels", () => {
    expect(SOCIAL_PLATFORMS).toEqual(["youtube", "instagram", "tiktok", "facebook", "x"]);
    expect(Object.keys(SOCIAL_PLATFORM_LABELS).sort()).toEqual([...SOCIAL_PLATFORMS].sort());
    for (const platform of SOCIAL_PLATFORMS) {
      expect(isSocialPlatform(platform)).toBe(true);
      expect(SOCIAL_PLATFORM_LABELS[platform].length, platform).toBeGreaterThan(0);
    }
  });

  it("keeps planned platforms out of the supported set", () => {
    // A platform in the planned list must not be selectable for publishing until it
    // is actually implemented; overlapping sets would make that a runtime surprise.
    for (const planned of PLANNED_SOCIAL_PLATFORMS) {
      expect(isSocialPlatform(planned), planned).toBe(false);
      expect(normaliseSocialPlatform(planned), planned).toBeNull();
    }
    expect(PLANNED_SOCIAL_PLATFORMS).toEqual(["linkedin", "threads", "twitch", "reddit"]);
  });

  it("normalises the casings and legacy names inbound signals use", () => {
    expect(normaliseSocialPlatform("YouTube")).toBe("youtube");
    expect(normaliseSocialPlatform("  YT ")).toBe("youtube");
    // Domain forms arrive from spreadsheet exports and webhook payloads.
    expect(normaliseSocialPlatform("YouTube.com")).toBe("youtube");
    expect(normaliseSocialPlatform("www.tiktok.com")).toBe("tiktok");
    expect(normaliseSocialPlatform("x.com")).toBe("x");
    expect(normaliseSocialPlatform("twitter.com")).toBe("x");
    expect(normaliseSocialPlatform("fb.com")).toBe("facebook");
    expect(normaliseSocialPlatform("Instagram.co.uk")).toBe("instagram");
    expect(normaliseSocialPlatform("IG")).toBe("instagram");
    expect(normaliseSocialPlatform("tik_tok")).toBe("tiktok");
    expect(normaliseSocialPlatform("twitter")).toBe("x");
  });

  it("returns null rather than attributing an unknown signal", () => {
    // Mis-attributing a signal corrupts analytics and can publish to the wrong
    // account, which is worse than dropping the record.
    expect(normaliseSocialPlatform("myspace")).toBeNull();
    expect(normaliseSocialPlatform("")).toBeNull();
    expect(normaliseSocialPlatform(undefined)).toBeNull();
    expect(normaliseSocialPlatform(1)).toBeNull();
  });
});
