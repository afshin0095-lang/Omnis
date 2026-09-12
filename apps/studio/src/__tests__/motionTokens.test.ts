/**
 * Motion adapter tests.
 *
 * The adapter converts CSS times and bezier expressions into framer-motion's numeric
 * API. Getting it wrong does not throw — it produces an animation that never finishes
 * or an easing that does not match the CSS animation of the same token, both of which
 * look like a rendering bug rather than a conversion bug.
 */

import { MOTION, REDUCED_MOTION } from "@omnis/theme";
import { describe, expect, it } from "vitest";
import { durationSeconds, easingTuple, resolveMotion } from "../lib/motionTokens";

describe("durationSeconds", () => {
  it("converts milliseconds and seconds", () => {
    expect(durationSeconds("250ms")).toBe(0.25);
    expect(durationSeconds("4s")).toBe(4);
    expect(durationSeconds("1.5s")).toBe(1.5);
    expect(durationSeconds("0ms")).toBe(0);
  });

  it("tolerates surrounding whitespace", () => {
    expect(durationSeconds("  450ms  ")).toBe(0.45);
  });

  it("converts every duration the theme publishes", () => {
    for (const [name, value] of Object.entries(MOTION.duration)) {
      expect(Number.isFinite(durationSeconds(value)), name).toBe(true);
      expect(durationSeconds(value), name).toBeGreaterThan(0);
    }
  });

  it("rejects a value that is not a CSS time", () => {
    // A NaN duration makes framer-motion hold the first frame forever.
    expect(() => durationSeconds("fast")).toThrow(RangeError);
    expect(() => durationSeconds("250")).toThrow(RangeError);
    expect(() => durationSeconds("")).toThrow(RangeError);
  });
});

describe("easingTuple", () => {
  it("parses a cubic bezier into control points", () => {
    expect(easingTuple("cubic-bezier(0.2, 0, 0, 1)")).toEqual([0.2, 0, 0, 1]);
    expect(easingTuple("cubic-bezier(0.16,1,0.3,1)")).toEqual([0.16, 1, 0.3, 1]);
  });

  it("parses every easing the theme publishes", () => {
    for (const [name, value] of Object.entries(MOTION.easing)) {
      const tuple = easingTuple(value);
      expect(tuple, name).toHaveLength(4);
      for (const point of tuple) {
        expect(Number.isFinite(point), `${name}: ${point}`).toBe(true);
      }
      // X control points must stay inside [0,1] or the curve is not a function of
      // time and the animation doubles back on itself.
      expect(tuple[0], name).toBeGreaterThanOrEqual(0);
      expect(tuple[0], name).toBeLessThanOrEqual(1);
      expect(tuple[2], name).toBeGreaterThanOrEqual(0);
      expect(tuple[2], name).toBeLessThanOrEqual(1);
    }
  });

  it("rejects a named easing rather than approximating it", () => {
    // An approximation would make the JS animation disagree with the CSS animation
    // driven by the same token, and the disagreement is visible.
    expect(() => easingTuple("ease-in-out")).toThrow(RangeError);
    expect(() => easingTuple("linear")).toThrow(RangeError);
  });
});

describe("resolveMotion", () => {
  it("resolves the theme's motion tokens into framer-motion units", () => {
    const resolved = resolveMotion(MOTION);
    expect(resolved.ambient).toBe(4);
    expect(resolved.normal).toBe(0.25);
    expect(resolved.fast).toBe(0.15);
    expect(resolved.standard).toEqual([0.2, 0, 0, 1]);
  });

  it("resolves reduced motion to zero durations", () => {
    // The Studio's ambient effects must stop, not merely slow down, for a visitor who
    // asked for reduced motion.
    const resolved = resolveMotion(REDUCED_MOTION);
    expect(resolved.ambient).toBe(0);
    expect(resolved.normal).toBe(0);
    expect(resolved.standard).toEqual([0.2, 0, 0, 1]);
  });
});
