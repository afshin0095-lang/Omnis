/**
 * Translating theme motion tokens into framer-motion's API.
 *
 * WHY AN ADAPTER IS NEEDED
 * ------------------------
 * The theme speaks CSS: durations are strings like `"250ms"` or `"6s"`, and easing is
 * a `cubic-bezier(...)` expression. framer-motion speaks numbers: seconds for
 * duration, and a four-element bezier tuple for easing. Something has to convert
 * between the two, and if each component does it inline the conversion is repeated
 * eight times and at least one of them will be wrong.
 *
 * Keeping the adapter here also means the theme stays the only place a duration is
 * defined: changing `deliberate` from 4s to 6s in the AI Studio theme changes the
 * orb, the aurora and the wordmark together.
 */

import type { DurationValue, MotionTokens } from "@omnis/theme";

/** A cubic-bezier control-point tuple, as framer-motion expects it. */
export type EasingTuple = [number, number, number, number];

/**
 * Converts a CSS time to seconds.
 *
 * @throws {RangeError} for a value that is not a CSS time. Failing loudly matters
 *   here: `Number.parseFloat("abc")` is NaN, and a NaN duration makes framer-motion
 *   hold the first frame forever — an animation that looks like a rendering bug.
 */
export function durationSeconds(value: DurationValue): number {
  const match = /^(\d+(?:\.\d+)?)(m?s)$/.exec(value.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new RangeError(`Expected a CSS time such as "250ms" or "4s", received "${value}"`);
  }
  const amount = Number.parseFloat(match[1]);
  return match[2] === "ms" ? amount / 1000 : amount;
}

/**
 * Parses a `cubic-bezier(...)` expression into control points.
 *
 * @throws {RangeError} when the expression is not a cubic bezier. Named easings such
 *   as `ease-in-out` are rejected rather than approximated, because an approximation
 *   would make the running animation disagree with the CSS animation of the same
 *   token — and the disagreement is visible.
 */
export function easingTuple(value: string): EasingTuple {
  const match =
    /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(
      value.trim(),
    );
  if (match === null) {
    throw new RangeError(`Expected a cubic-bezier() easing expression, received "${value}"`);
  }
  const points = match.slice(1).map(Number.parseFloat);
  const [x1, y1, x2, y2] = points as [number, number, number, number];
  return [x1, y1, x2, y2];
}

/** The motion values a Studio component needs, already in framer-motion's units. */
export interface ResolvedMotion {
  /** Ambient duration, for the orb and the aurora. */
  readonly ambient: number;
  /** Interaction duration, for reveals and hovers. */
  readonly normal: number;
  /** Quick duration, for micro-feedback. */
  readonly fast: number;
  readonly emphasized: EasingTuple;
  readonly standard: EasingTuple;
  readonly decelerate: EasingTuple;
}

/** Resolves a theme's motion tokens once, so components do not each re-parse them. */
export function resolveMotion(motion: MotionTokens): ResolvedMotion {
  return {
    ambient: durationSeconds(motion.duration.deliberate),
    normal: durationSeconds(motion.duration.normal),
    fast: durationSeconds(motion.duration.fast),
    emphasized: easingTuple(motion.easing.emphasized),
    standard: easingTuple(motion.easing.standard),
    decelerate: easingTuple(motion.easing.decelerate),
  };
}
