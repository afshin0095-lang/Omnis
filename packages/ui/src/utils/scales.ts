/**
 * Prop value -> CSS custom property maps.
 *
 * Components accept design-system vocabulary (`padding={4}`, `radius="lg"`,
 * `elevation="glow"`) and translate it once, here, into the custom property the
 * theme publishes. Keeping the translation in one place means a component cannot
 * invent its own pixel value, and a scale change in `@omnis/theme` reaches every
 * component without an edit in any of them.
 *
 * Each map is typed against the theme's own token keys, so a step added to the
 * scale is a compile error here until it is mapped — which is exactly when someone
 * should be told about it.
 */

import { CSS_VARS } from "./cssVars.js";
import type { Elevation, RadiusScale, SpacingStep } from "../types.js";

/** Spacing scale step to its CSS variable. */
export const SPACE_VAR: Readonly<Record<SpacingStep, string>> = {
  0: CSS_VARS.space0,
  1: CSS_VARS.space1,
  2: CSS_VARS.space2,
  3: CSS_VARS.space3,
  4: CSS_VARS.space4,
  5: CSS_VARS.space5,
  6: CSS_VARS.space6,
  8: "var(--omnis-space-8)",
  10: "var(--omnis-space-10)",
  12: CSS_VARS.space12,
  16: CSS_VARS.space16,
};

/** Radius scale step to its CSS variable. */
export const RADIUS_VAR: Readonly<Record<RadiusScale, string>> = {
  none: CSS_VARS.radiusNone,
  sm: CSS_VARS.radiusSm,
  md: CSS_VARS.radiusMd,
  lg: CSS_VARS.radiusLg,
  xl: CSS_VARS.radiusXl,
  pill: CSS_VARS.radiusPill,
};

/** Elevation name to the theme's shadow variable. */
export const ELEVATION_VAR: Readonly<Record<Elevation, string>> = {
  none: CSS_VARS.shadowNone,
  sm: CSS_VARS.shadowSm,
  md: CSS_VARS.shadowMd,
  lg: CSS_VARS.shadowLg,
  glow: CSS_VARS.shadowGlow,
};

/**
 * Every spacing step the UI layer understands, in scale order.
 *
 * Declared as a literal tuple rather than derived with `Object.keys`, so consumers
 * and tests see the real steps instead of `string`. The two `satisfies` clauses are
 * what keep the three lists honest: an entry here that is not a theme key stops
 * compiling, and the `Record<SpacingStep, string>` annotation on {@link SPACE_VAR}
 * above stops compiling if the theme gains a step this layer has not mapped.
 */
export const SPACING_STEPS = [
  0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16,
] as const satisfies readonly SpacingStep[];

/** Every radius step the UI layer understands, from square to fully rounded. */
export const RADIUS_SCALES = [
  "none",
  "sm",
  "md",
  "lg",
  "xl",
  "pill",
] as const satisfies readonly RadiusScale[];
