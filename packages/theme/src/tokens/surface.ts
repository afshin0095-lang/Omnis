/**
 * Surface treatments.
 *
 * The glass panel is a core OMNIS surface: translucent, blurred, edged with a
 * hairline border, sitting over an animated background. Its parameters are tokens
 * rather than component internals so that a theme can make glass more or less
 * opaque — which matters for accessibility, since a panel over a bright aurora can
 * drop text contrast below a readable level.
 */

import type { ColorValue, SurfaceTokens } from "../themes/types.js";

/** Builds the surface set for a theme. */
export function createSurfaces(overlay: ColorValue, glassOpacity: number): SurfaceTokens {
  return {
    glass: {
      blur: "18px",
      opacity: glassOpacity,
      borderOpacity: 0.14,
    },
    overlay,
  };
}

export const DARK_SURFACES: SurfaceTokens = createSurfaces("rgba(4, 7, 14, 0.72)", 0.05);

export const LIGHT_SURFACES: SurfaceTokens = createSurfaces("rgba(247, 249, 252, 0.68)", 0.72);
