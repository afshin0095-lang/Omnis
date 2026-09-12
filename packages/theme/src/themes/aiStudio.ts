/**
 * The AI Studio theme.
 *
 * WHY A THIRD THEME
 * -----------------
 * The dark theme is the product's neutral surface: readable, calm, suitable for
 * long editing sessions. The Studio is something else — the place where an
 * operator watches autonomous characters work, where the interface is meant to feel
 * like instrumentation around a live system rather than a document.
 *
 * That difference is a *theme*, not a component variant, because it changes every
 * surface at once: a deeper void so emission reads as light rather than tint, a
 * stronger aurora, glass panels that carry more blur, longer and more emphatic
 * motion, and a cyan-forward accent. Expressing it as a theme means the same
 * component tree renders as either product without a single conditional.
 *
 * It composes the shared scales (type, spacing, radii, layers, breakpoints) and
 * overrides only what the aesthetic genuinely requires.
 */

import type { ColorTokens, Theme } from "./types.js";
import { OMNIS_BLUE, OMNIS_CYAN, OMNIS_VIOLET, STATUS } from "../tokens/colors.js";
import { BREAKPOINTS } from "../tokens/breakpoints.js";
import { COMPONENTS } from "../tokens/components.js";
import { MOTION, REDUCED_MOTION } from "../tokens/motion.js";
import { RADIUS } from "../tokens/radius.js";
import { createShadows } from "../tokens/shadows.js";
import { SPACING } from "../tokens/spacing.js";
import { createSurfaces } from "../tokens/surface.js";
import { TYPOGRAPHY } from "../tokens/typography.js";
import { Z_INDEX } from "../tokens/zIndex.js";

/**
 * Colour roles for the Studio.
 *
 * The background is deliberately darker than the dark theme's: emission effects
 * (the orb, the aurora, focus glows) are only legible as *light* against something
 * close to black. Against `#070b14` a glow reads as a blue tint; against `#03050b`
 * it reads as a source.
 */
export const AI_STUDIO_COLORS: ColorTokens = {
  background: "#03050b",
  surface: "rgba(120, 190, 255, 0.05)",
  surfaceRaised: "rgba(120, 190, 255, 0.08)",
  surfaceGlass: "rgba(140, 200, 255, 0.06)",
  surfaceActive: "rgba(120, 190, 255, 0.14)",
  text: "#eaf4ff",
  textMuted: "rgba(234, 244, 255, 0.70)",
  textSubtle: "rgba(234, 244, 255, 0.44)",
  textOnPrimary: "#03050b",
  primary: OMNIS_CYAN.base,
  primaryGlow: "rgba(0, 255, 255, 0.45)",
  secondary: OMNIS_VIOLET.base,
  accent: OMNIS_BLUE.base,
  success: STATUS.success,
  warning: STATUS.warning,
  danger: STATUS.danger,
  info: STATUS.info,
  border: "rgba(140, 200, 255, 0.18)",
  borderSubtle: "rgba(140, 200, 255, 0.08)",
  borderFocus: "rgba(0, 255, 255, 0.6)",
  aurora: [OMNIS_CYAN.base, OMNIS_VIOLET.base, OMNIS_BLUE.base],
};

/**
 * The Studio aurora.
 *
 * Four layers rather than three: the extra low-opacity sweep across the middle of
 * the viewport is what makes the background read as depth instead of as three
 * unrelated blobs.
 */
export const AI_STUDIO_AURORA_LAYERS = [
  "radial-gradient(circle at 18% 8%, rgba(0, 255, 255, 0.20), transparent 40%)",
  "radial-gradient(circle at 82% 16%, rgba(140, 90, 255, 0.22), transparent 38%)",
  "radial-gradient(circle at 50% 62%, rgba(87, 182, 255, 0.12), transparent 46%)",
  "radial-gradient(circle at 50% 104%, rgba(0, 255, 255, 0.10), transparent 48%)",
] as const;

/**
 * Motion for the Studio.
 *
 * Slower and more emphatic than the product default. Ambient motion in an
 * instrumentation surface should feel like a system breathing, not like UI
 * responding to input; interaction durations are untouched so the interface still
 * feels immediate.
 */
export const AI_STUDIO_MOTION = {
  ...MOTION,
  duration: { ...MOTION.duration, slow: "600ms", deliberate: "6s" },
  easing: { ...MOTION.easing, emphasized: "cubic-bezier(0.16, 1, 0.3, 1)" },
} as const;

/** Reduced-motion counterpart, so the Studio honours the same preference. */
export const AI_STUDIO_REDUCED_MOTION = REDUCED_MOTION;

/** Glass is heavier in the Studio: more blur, slightly more presence. */
export const AI_STUDIO_SURFACES = {
  ...createSurfaces("rgba(3, 5, 11, 0.78)", 0.06),
  glass: { blur: "26px", opacity: 0.06, borderOpacity: 0.18 },
} as const;

export const AI_STUDIO_THEME: Theme = {
  id: "omnis-ai-studio",
  name: "OMNIS AI Studio",
  colorScheme: "dark",
  colors: AI_STUDIO_COLORS,
  typography: TYPOGRAPHY,
  spacing: SPACING,
  radius: RADIUS,
  shadows: createShadows("rgba(0, 255, 255, 0.5)", "rgba(87, 182, 255, 0.22)"),
  motion: AI_STUDIO_MOTION,
  zIndex: Z_INDEX,
  breakpoints: BREAKPOINTS,
  surfaces: AI_STUDIO_SURFACES,
  effects: {
    aurora: { layers: AI_STUDIO_AURORA_LAYERS },
    orb: {
      size: "168px",
      core: `radial-gradient(circle at 34% 28%, rgba(255, 255, 255, 0.95), rgba(0, 255, 255, 0.45) 26%, rgba(87, 182, 255, 0.22) 58%, transparent 78%)`,
      breatheScale: 1.09,
    },
  },
  components: COMPONENTS,
};
