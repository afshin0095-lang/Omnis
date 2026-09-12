/**
 * Responsive breakpoints and the media queries built from them.
 *
 * WHY HELPERS RATHER THAN RAW STRINGS
 * -----------------------------------
 * A breakpoint scale on its own still leaves every component writing its own
 * `@media (min-width: 1024px)` — at which point the scale is decorative and the
 * real thresholds are scattered across the codebase. The helpers below make the
 * scale the only place a pixel value appears.
 *
 * `between` and `only` use `max-width: <next - 0.02px>` rather than
 * `<next - 1px>` so that fractional-DPI viewports sitting between two integers
 * match exactly one query. An overlap or a gap of one physical pixel produces
 * layouts that flicker while resizing, which is very visible and very hard to
 * diagnose.
 */

import type { BreakpointTokens } from "../themes/types.js";

/** Named breakpoints, smallest first. */
export const BREAKPOINTS: BreakpointTokens = {
  xs: "0px",
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
};

/** Breakpoint names in ascending order. */
export const BREAKPOINT_NAMES = ["xs", "sm", "md", "lg", "xl", "2xl"] as const;

/** One member of {@link BREAKPOINT_NAMES}. */
export type BreakpointName = (typeof BREAKPOINT_NAMES)[number];

/** Offset used to build an exclusive upper bound. */
const EXCLUSIVE_EDGE = "0.02px";

/** Parses a CSS length in px, or returns null for anything else. */
function pxOf(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  return match === null || match[1] === undefined ? null : Number.parseFloat(match[1]);
}

/** The breakpoint that follows `name`, or null for the largest. */
export function nextBreakpoint(name: BreakpointName): BreakpointName | null {
  const index = BREAKPOINT_NAMES.indexOf(name);
  if (index < 0 || index === BREAKPOINT_NAMES.length - 1) {
    return null;
  }
  return BREAKPOINT_NAMES[index + 1] ?? null;
}

/** `min-width` query: this breakpoint and everything wider. */
export function mediaUp(name: BreakpointName): string {
  return `@media (min-width: ${BREAKPOINTS[name]})`;
}

/** `max-width` query: everything narrower than this breakpoint. */
export function mediaDown(name: BreakpointName): string {
  const upper = pxOf(BREAKPOINTS[name]);
  if (upper === null) {
    return `@media (max-width: ${BREAKPOINTS[name]})`;
  }
  return `@media (max-width: ${Math.max(0, upper - Number.parseFloat(EXCLUSIVE_EDGE))}px)`;
}

/** Inclusive range query between two breakpoints. */
export function mediaBetween(from: BreakpointName, to: BreakpointName): string {
  return `@media (min-width: ${BREAKPOINTS[from]}) and (max-width: ${BREAKPOINTS[to]})`;
}

/** Query matching only the band a single breakpoint is responsible for. */
export function mediaOnly(name: BreakpointName): string {
  const next = nextBreakpoint(name);
  if (next === null) {
    return mediaUp(name);
  }
  return mediaBetween(name, next);
}

/** Container-query equivalent of {@link mediaUp}, for size-based layout. */
export function containerUp(name: BreakpointName): string {
  return `@container (min-width: ${BREAKPOINTS[name]})`;
}
