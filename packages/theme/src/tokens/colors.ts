/**
 * Colour palettes.
 *
 * Raw values live here; semantic roles are assembled in `themes/`. That split
 * matters: a new theme should be able to reuse the OMNIS brand ramp without
 * copying hex literals, and a brand colour change should be one edit rather than a
 * sweep through every theme.
 *
 * The dark values are carried over from the pre-Sprint-0 Studio stylesheet
 * (`apps/studio/src/styles/themes.css`) so the visual identity already established
 * for OMNIS is preserved rather than reinvented.
 */

import type { ColorTokens } from "../themes/types.js";

/** The OMNIS signature blue and its emission variants. */
export const OMNIS_BLUE = {
  base: "#57b6ff",
  glow: "rgba(87, 182, 255, 0.35)",
  glowStrong: "rgba(87, 182, 255, 0.55)",
  deep: "#1f6fb2",
  pale: "#a8d8ff",
} as const;

/** Secondary and accent hues, used for gradients and data visualisation. */
export const OMNIS_VIOLET = {
  base: "#8c5aff",
  glow: "rgba(140, 90, 255, 0.35)",
} as const;

export const OMNIS_CYAN = {
  base: "#00ffff",
  glow: "rgba(0, 255, 255, 0.25)",
} as const;

/** A neutral ramp tuned for dark surfaces: cool, slightly blue-shifted. */
export const DARK_NEUTRALS = {
  void: "#070b14",
  surface: "rgba(255, 255, 255, 0.04)",
  surfaceRaised: "rgba(255, 255, 255, 0.07)",
  surfaceGlass: "rgba(255, 255, 255, 0.05)",
  surfaceActive: "rgba(255, 255, 255, 0.10)",
  text: "#ffffff",
  textMuted: "rgba(255, 255, 255, 0.72)",
  textSubtle: "rgba(255, 255, 255, 0.48)",
  border: "rgba(255, 255, 255, 0.14)",
  borderSubtle: "rgba(255, 255, 255, 0.07)",
} as const;

/** A neutral ramp tuned for light surfaces. */
export const LIGHT_NEUTRALS = {
  void: "#f7f9fc",
  surface: "#ffffff",
  surfaceRaised: "#ffffff",
  surfaceGlass: "rgba(255, 255, 255, 0.72)",
  surfaceActive: "rgba(31, 111, 178, 0.08)",
  text: "#08060d",
  textMuted: "#4d5566",
  textSubtle: "#7c8698",
  border: "#dde3ec",
  borderSubtle: "#eef1f6",
} as const;

/** Status colours, shared by both schemes. */
export const STATUS = {
  success: "#3ddc97",
  warning: "#ffc857",
  danger: "#ff5d73",
  info: OMNIS_BLUE.base,
} as const;

/**
 * The aurora layers that make up the OMNIS animated background.
 *
 * Expressed as complete CSS gradient layers so a theme can reorder or restyle
 * them without a component knowing how many there are.
 */
export const DARK_AURORA_LAYERS = [
  "radial-gradient(circle at 20% 10%, rgba(87, 182, 255, 0.22), transparent 42%)",
  "radial-gradient(circle at 80% 20%, rgba(140, 90, 255, 0.14), transparent 35%)",
  "radial-gradient(circle at 50% 100%, rgba(0, 255, 255, 0.08), transparent 45%)",
] as const;

export const LIGHT_AURORA_LAYERS = [
  "radial-gradient(circle at 20% 10%, rgba(87, 182, 255, 0.18), transparent 42%)",
  "radial-gradient(circle at 80% 20%, rgba(140, 90, 255, 0.12), transparent 35%)",
  "radial-gradient(circle at 50% 100%, rgba(61, 220, 151, 0.10), transparent 45%)",
] as const;

/** Semantic colour roles for the dark scheme. */
export const DARK_COLORS: ColorTokens = {
  background: DARK_NEUTRALS.void,
  surface: DARK_NEUTRALS.surface,
  surfaceRaised: DARK_NEUTRALS.surfaceRaised,
  surfaceGlass: DARK_NEUTRALS.surfaceGlass,
  surfaceActive: DARK_NEUTRALS.surfaceActive,
  text: DARK_NEUTRALS.text,
  textMuted: DARK_NEUTRALS.textMuted,
  textSubtle: DARK_NEUTRALS.textSubtle,
  textOnPrimary: DARK_NEUTRALS.void,
  primary: OMNIS_BLUE.base,
  primaryGlow: OMNIS_BLUE.glow,
  secondary: OMNIS_VIOLET.base,
  accent: OMNIS_CYAN.base,
  success: STATUS.success,
  warning: STATUS.warning,
  danger: STATUS.danger,
  info: STATUS.info,
  border: DARK_NEUTRALS.border,
  borderSubtle: DARK_NEUTRALS.borderSubtle,
  borderFocus: OMNIS_BLUE.glowStrong,
  aurora: [OMNIS_BLUE.base, OMNIS_VIOLET.base, OMNIS_CYAN.base],
};

/** Semantic colour roles for the light scheme. */
export const LIGHT_COLORS: ColorTokens = {
  background: LIGHT_NEUTRALS.void,
  surface: LIGHT_NEUTRALS.surface,
  surfaceRaised: LIGHT_NEUTRALS.surfaceRaised,
  surfaceGlass: LIGHT_NEUTRALS.surfaceGlass,
  surfaceActive: LIGHT_NEUTRALS.surfaceActive,
  text: LIGHT_NEUTRALS.text,
  textMuted: LIGHT_NEUTRALS.textMuted,
  textSubtle: LIGHT_NEUTRALS.textSubtle,
  textOnPrimary: "#ffffff",
  primary: OMNIS_BLUE.deep,
  primaryGlow: "rgba(31, 111, 178, 0.28)",
  secondary: OMNIS_VIOLET.base,
  accent: "#0e8f8f",
  success: "#1a9d68",
  warning: "#b57a00",
  danger: "#d13350",
  info: OMNIS_BLUE.deep,
  border: LIGHT_NEUTRALS.border,
  borderSubtle: LIGHT_NEUTRALS.borderSubtle,
  borderFocus: "rgba(31, 111, 178, 0.45)",
  aurora: [OMNIS_BLUE.base, OMNIS_VIOLET.base, STATUS.success],
};
