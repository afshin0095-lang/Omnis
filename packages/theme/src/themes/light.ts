/**
 * The light OMNIS theme.
 *
 * Shares the type scale, spacing, radii and component dimensions with the dark
 * theme — those are density and rhythm decisions, not skin decisions — and differs
 * only where a light environment genuinely demands it: colour, elevation weight
 * and emission strength.
 *
 * A glow is only visible against something dark, so `glow*` shadows are much
 * weaker here; keeping them at dark-theme strength would produce grey smudges
 * rather than light.
 */

import type { Theme } from "./types.js";
import { LIGHT_AURORA_LAYERS, LIGHT_COLORS } from "../tokens/colors.js";
import { COMPONENTS } from "../tokens/components.js";
import { MOTION } from "../tokens/motion.js";
import { BREAKPOINTS } from "../tokens/breakpoints.js";
import { Z_INDEX } from "../tokens/zIndex.js";
import { RADIUS } from "../tokens/radius.js";
import { LIGHT_SHADOWS } from "../tokens/shadows.js";
import { SPACING } from "../tokens/spacing.js";
import { LIGHT_SURFACES } from "../tokens/surface.js";
import { TYPOGRAPHY } from "../tokens/typography.js";

export const LIGHT_THEME: Theme = {
  id: "omnis-light",
  name: "OMNIS Light",
  colorScheme: "light",
  colors: LIGHT_COLORS,
  typography: TYPOGRAPHY,
  spacing: SPACING,
  radius: RADIUS,
  shadows: LIGHT_SHADOWS,
  motion: MOTION,
  zIndex: Z_INDEX,
  breakpoints: BREAKPOINTS,
  surfaces: LIGHT_SURFACES,
  effects: {
    aurora: { layers: LIGHT_AURORA_LAYERS },
    orb: {
      size: "120px",
      core: `radial-gradient(circle at 35% 30%, rgba(255, 255, 255, 1), rgba(87, 182, 255, 0.45) 30%, rgba(87, 182, 255, 0.12) 70%, transparent)`,
      breatheScale: 1.04,
    },
  },
  components: COMPONENTS,
};
