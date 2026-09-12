/**
 * The default OMNIS theme: dark, cool, emissive.
 *
 * This is the visual direction the Studio already ships — a near-black
 * blue-shifted void, an aurora of three radial gradients, white type and an
 * OMNIS-blue glow. It is preserved here as structured data so that it can be
 * applied at runtime, varied per tenant, and consumed by non-web renderers.
 */

import type { Theme } from "./types.js";
import { DARK_AURORA_LAYERS, DARK_COLORS, OMNIS_BLUE } from "../tokens/colors.js";
import { COMPONENTS } from "../tokens/components.js";
import { MOTION } from "../tokens/motion.js";
import { BREAKPOINTS } from "../tokens/breakpoints.js";
import { Z_INDEX } from "../tokens/zIndex.js";
import { RADIUS } from "../tokens/radius.js";
import { DARK_SHADOWS } from "../tokens/shadows.js";
import { SPACING } from "../tokens/spacing.js";
import { DARK_SURFACES } from "../tokens/surface.js";
import { TYPOGRAPHY } from "../tokens/typography.js";

export const DARK_THEME: Theme = {
  id: "omnis-dark",
  name: "OMNIS Dark",
  colorScheme: "dark",
  colors: DARK_COLORS,
  typography: TYPOGRAPHY,
  spacing: SPACING,
  radius: RADIUS,
  shadows: DARK_SHADOWS,
  motion: MOTION,
  zIndex: Z_INDEX,
  breakpoints: BREAKPOINTS,
  surfaces: DARK_SURFACES,
  effects: {
    aurora: { layers: DARK_AURORA_LAYERS },
    orb: {
      size: "120px",
      core: `radial-gradient(circle at 35% 30%, rgba(255, 255, 255, 0.9), ${OMNIS_BLUE.glow} 30%, rgba(87, 182, 255, 0.2) 70%, transparent)`,
      breatheScale: 1.06,
    },
  },
  components: COMPONENTS,
};
