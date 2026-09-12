/**
 * Motion tokens.
 *
 * Animation is part of the OMNIS visual identity — the interface is meant to feel
 * alive — which is exactly why it has to be controllable. `reduced` is a
 * theme-level switch so that `prefers-reduced-motion`, a screen-recording
 * environment or a low-power device can suppress motion through data rather than
 * through a hundred component-level conditionals.
 *
 * `deliberate` exists for the long-form ambient motion (the breathing orb, the
 * aurora drift) whose timescale is unrelated to interaction feedback and should
 * never be shortened just because someone wanted a snappier button.
 */

import type { MotionTokens } from "../themes/types.js";

export const MOTION: MotionTokens = {
  duration: {
    instant: "80ms",
    fast: "150ms",
    normal: "250ms",
    slow: "450ms",
    deliberate: "4s",
  },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    emphasized: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    decelerate: "cubic-bezier(0, 0, 0.2, 1)",
    accelerate: "cubic-bezier(0.4, 0, 1, 1)",
  },
  reduced: false,
};

/**
 * A motion set with every animation collapsed to its shortest form.
 *
 * Durations become `0ms` rather than being removed, so components can keep
 * applying transitions unconditionally and still render instantly. Removing the
 * properties instead would force every component to branch on `reduced`.
 */
export const REDUCED_MOTION: MotionTokens = {
  duration: {
    instant: "0ms",
    fast: "0ms",
    normal: "0ms",
    slow: "0ms",
    deliberate: "0ms",
  },
  easing: MOTION.easing,
  reduced: true,
};
