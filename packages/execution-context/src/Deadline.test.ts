import { describe, expect, it } from "vitest";
import { ValidationError } from "@omnis/errors";
import { fixedClock } from "./Clock.js";
import {
  assertDeadlineDuration,
  boundDeadline,
  createDeadline,
  deadlineAt,
  deadlineIso,
  earliestDeadline,
  expiresWithin,
  isExpired,
  remainingMs,
  remainingMsAt,
} from "./Deadline.js";

describe("createDeadline", () => {
  it("records the absolute instant and the duration that produced it", () => {
    const deadline = createDeadline(1_000, 30_000);
    expect(deadline).toEqual({ atMs: 31_000, durationMs: 30_000, createdAtMs: 1_000 });
    expect(Object.isFrozen(deadline)).toBe(true);
  });

  it("rejects a non-positive or fractional duration", () => {
    // A zero deadline is already expired at creation, and would report as a timeout
    // instead of the caller mistake it is.
    expect(() => createDeadline(1_000, 0)).toThrow(ValidationError);
    expect(() => createDeadline(1_000, -5)).toThrow(ValidationError);
    expect(() => createDeadline(1_000, 1.5)).toThrow(ValidationError);
    expect(() => createDeadline(1.5, 1_000)).toThrow(ValidationError);
    expect(() => assertDeadlineDuration(Number.NaN)).toThrow(ValidationError);
  });
});

describe("deadlineAt", () => {
  it("derives the duration from an absolute instant", () => {
    expect(deadlineAt(1_000, 6_000)).toEqual({
      atMs: 6_000,
      durationMs: 5_000,
      createdAtMs: 1_000,
    });
  });

  it("rejects an instant that has already passed", () => {
    expect(() => deadlineAt(1_000, 1_000)).toThrow(ValidationError);
    expect(() => deadlineAt(1_000, 500)).toThrow(ValidationError);
  });
});

describe("remainingMs", () => {
  const deadline = createDeadline(0, 10_000);

  it("counts down as time passes", () => {
    expect(remainingMs(deadline, 0)).toBe(10_000);
    expect(remainingMs(deadline, 4_000)).toBe(6_000);
    expect(remainingMs(deadline, 10_000)).toBe(0);
  });

  it("clamps at zero rather than reporting negative time", () => {
    // A negative remaining time would flow into setTimeout as an immediate fire and into
    // a duration budget hold as a negative amount.
    expect(remainingMs(deadline, 25_000)).toBe(0);
  });

  it("is null when there is no deadline", () => {
    expect(remainingMs(null, 25_000)).toBeNull();
  });

  it("reads through a clock", () => {
    expect(remainingMsAt(deadline, fixedClock(2_500))).toBe(7_500);
    expect(remainingMsAt(null, fixedClock(2_500))).toBeNull();
  });
});

describe("expiry", () => {
  const deadline = createDeadline(0, 10_000);

  it("expires exactly at the deadline instant", () => {
    expect(isExpired(deadline, 9_999)).toBe(false);
    expect(isExpired(deadline, 10_000)).toBe(true);
    expect(isExpired(deadline, 10_001)).toBe(true);
  });

  it("never expires without a deadline", () => {
    expect(isExpired(null, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("reports an approaching deadline within a horizon", () => {
    expect(expiresWithin(deadline, 8_000, 2_000)).toBe(true);
    expect(expiresWithin(deadline, 7_999, 2_000)).toBe(false);
    expect(expiresWithin(null, 8_000, 2_000)).toBe(false);
  });

  it("formats the instant as an ISO timestamp", () => {
    expect(deadlineIso(createDeadline(0, 1_000))).toBe("1970-01-01T00:00:01.000Z");
  });
});

describe("earliestDeadline", () => {
  it("treats null as no limit", () => {
    const deadline = createDeadline(0, 5_000);
    expect(earliestDeadline(null, deadline)).toBe(deadline);
    expect(earliestDeadline(deadline, null)).toBe(deadline);
    expect(earliestDeadline(null, null)).toBeNull();
  });

  it("picks the sooner instant", () => {
    const sooner = createDeadline(0, 5_000);
    const later = createDeadline(0, 50_000);
    expect(earliestDeadline(later, sooner)).toBe(sooner);
  });
});

describe("boundDeadline", () => {
  it("lets a child ask for less than its parent allows", () => {
    const parent = createDeadline(0, 30_000);
    const child = createDeadline(10_000, 5_000);
    expect(boundDeadline(parent, child)).toBe(child);
  });

  it("caps a child that asks for more than its parent allows", () => {
    // Without the cap, a deep call tree would each add its own timeout and the root
    // execution would run for the sum of them, long past its own deadline.
    const parent = createDeadline(0, 10_000);
    const child = createDeadline(2_000, 60_000);
    const bounded = boundDeadline(parent, child);
    expect(bounded?.atMs).toBe(parent.atMs);
    expect(bounded?.atMs).toBeLessThan(child.atMs);
    expect(remainingMs(bounded ?? null, 2_000)).toBe(8_000);
  });

  it("inherits the parent deadline when the child asks for none", () => {
    const parent = createDeadline(0, 10_000);
    expect(boundDeadline(parent, null)).toBe(parent);
    expect(boundDeadline(null, null)).toBeNull();
  });
});
