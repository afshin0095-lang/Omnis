import { describe, expect, it } from "vitest";
import { fixedClock, manualClock, systemClock, toIso } from "./Clock.js";

describe("systemClock", () => {
  it("reads the wall clock and never goes backwards between two reads", () => {
    const first = systemClock();
    const second = systemClock();
    expect(second).toBeGreaterThanOrEqual(first);
    expect(Number.isInteger(first)).toBe(true);
  });
});

describe("manualClock", () => {
  it("starts where it is told and only moves when advanced", () => {
    const clock = manualClock(1_000);
    expect(clock()).toBe(1_000);
    expect(clock()).toBe(1_000);
    clock.advance(250);
    expect(clock()).toBe(1_250);
    expect(clock.now()).toBe(1_250);
  });

  it("sets an absolute reading", () => {
    const clock = manualClock(0);
    clock.set(5_000);
    expect(clock()).toBe(5_000);
  });

  it("counts reads so a test can prove nothing busy-polls", () => {
    const clock = manualClock(0);
    expect(clock.readCount()).toBe(0);
    clock();
    clock.now();
    expect(clock.readCount()).toBe(2);
    // Controlling the clock must not itself count as reading it.
    clock.advance(10);
    clock.set(20);
    expect(clock.readCount()).toBe(2);
  });

  it("refuses a fractional or negative advance", () => {
    const clock = manualClock(0);
    expect(() => clock.advance(1.5)).toThrow(RangeError);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(() => manualClock(1.5)).toThrow(RangeError);
    expect(() => clock.set(1.5)).toThrow(RangeError);
  });

  it("is usable wherever a plain clock is expected", () => {
    const asClock: () => number = manualClock(42);
    expect(asClock()).toBe(42);
  });
});

describe("fixedClock", () => {
  it("always returns the same reading", () => {
    const clock = fixedClock(1_700_000_000_000);
    expect(clock()).toBe(1_700_000_000_000);
    expect(clock()).toBe(clock());
    expect(() => fixedClock(Number.NaN)).toThrow(RangeError);
  });
});

describe("toIso", () => {
  it("formats epoch milliseconds as a UTC timestamp", () => {
    expect(toIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(() => toIso(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
