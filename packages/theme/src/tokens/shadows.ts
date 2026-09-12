/**
 * Elevation and emission shadows.
 *
 * OMNIS uses two kinds of shadow and keeps them separate:
 *
 * - **Elevation** (`sm`, `md`, `lg`) says "this surface is above that one".
 * - **Emission** (`glow`, `glowStrong`) says "this element is producing light".
 *
 * Emission is the signature of the OMNIS visual language — the breathing orb, the
 * focus ring, an active primary button. Modelling it as a shadow token rather than
 * a component-local `box-shadow` is what lets a theme change the colour of every
 * glow in the product at once.
 *
 * Both are functions of a glow colour so a light theme can reuse the same geometry
 * with a different emission hue.
 */

import type { ColorValue, ShadowTokens } from "../themes/types.js";

/** Builds the shadow set for a theme, given its emission colour. */
export function createShadows(glow: ColorValue, glowStrong: ColorValue): ShadowTokens {
  return {
    none: "none",
    sm: "0 1px 2px rgba(0, 0, 0, 0.24)",
    md: "0 4px 12px rgba(0, 0, 0, 0.28)",
    lg: "0 12px 32px rgba(0, 0, 0, 0.36)",
    glow: `0 0 40px ${glow}`,
    glowStrong: `0 0 40px ${glow}, 0 0 120px ${glowStrong}`,
  };
}

/** Shadows for a dark scheme, using the OMNIS blue emission. */
export const DARK_SHADOWS: ShadowTokens = createShadows(
  "rgba(87, 182, 255, 0.45)",
  "rgba(87, 182, 255, 0.18)",
);

/**
 * Shadows for a light scheme.
 *
 * Elevation is much lighter — on a white background a heavy drop shadow reads as
 * dirty rather than raised — and emission is reduced, because a glow is only
 * visible against something dark.
 */
export const LIGHT_SHADOWS: ShadowTokens = {
  none: "none",
  sm: "0 1px 2px rgba(15, 23, 42, 0.06)",
  md: "0 4px 12px rgba(15, 23, 42, 0.08)",
  lg: "0 12px 32px rgba(15, 23, 42, 0.12)",
  glow: "0 0 32px rgba(31, 111, 178, 0.22)",
  glowStrong: "0 0 32px rgba(31, 111, 178, 0.22), 0 0 90px rgba(31, 111, 178, 0.12)",
};
