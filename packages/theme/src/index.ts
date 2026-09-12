/**
 * `@omnis/theme` — OMNIS design tokens and themes.
 *
 * Pure data: no React, no CSS pipeline, no runtime dependency of any kind. A theme
 * is a plain serializable object, which is what makes it possible to switch themes
 * at runtime, to derive a tenant-branded variant from a partial override, and to
 * drive a non-web renderer from the same values.
 *
 * LAYERING
 * --------
 * `tokens/`  raw scales, shared by every theme.
 * `themes/`  composed themes and the `Theme` type.
 * `css/`     the projection of a theme into CSS custom properties.
 * `utils/`   composition (`mergeTheme`) and typed access (`resolveToken`).
 *
 * This package must not import from `@omnis/ui`, `apps/*` or any service. The
 * dependency direction is enforced by the architecture tests.
 */

export type {
  BreakpointTokens,
  ColorScheme,
  ColorTokens,
  ColorValue,
  ComponentTokens,
  DurationValue,
  EffectTokens,
  LengthValue,
  MotionTokens,
  RadiusTokens,
  ShadowTokens,
  SpacingTokens,
  SurfaceTokens,
  Theme,
  TypographyTokens,
  ZIndexTokens,
} from "./themes/types.js";

export {
  BREAKPOINT_NAMES,
  BREAKPOINTS,
  COMPONENTS,
  containerUp,
  createShadows,
  createSurfaces,
  DARK_AURORA_LAYERS,
  DARK_COLORS,
  DARK_NEUTRALS,
  DARK_SHADOWS,
  DARK_SURFACES,
  isKnownZIndex,
  LIGHT_AURORA_LAYERS,
  LIGHT_COLORS,
  LIGHT_SHADOWS,
  LIGHT_NEUTRALS,
  LIGHT_SURFACES,
  mediaBetween,
  mediaDown,
  mediaOnly,
  mediaUp,
  MOTION,
  nextBreakpoint,
  OMNIS_BLUE,
  OMNIS_CYAN,
  OMNIS_VIOLET,
  RADIUS,
  REDUCED_MOTION,
  SPACING,
  SPACING_BASE_PX,
  STATUS,
  TYPOGRAPHY,
  Z_INDEX,
} from "./tokens/index.js";
export type { BreakpointName } from "./tokens/index.js";

export {
  AI_STUDIO_AURORA_LAYERS,
  AI_STUDIO_COLORS,
  AI_STUDIO_THEME,
  DARK_THEME,
  DEFAULT_THEME,
  isKnownThemeId,
  LIGHT_THEME,
  resolveTheme,
  STUDIO_THEME,
  THEMES,
  themeIds,
} from "./themes/index.js";

export {
  auroraBackground,
  CSS_VARIABLE_PREFIX,
  themeToCss,
  themeToCssVariables,
  themeTokens,
} from "./css/index.js";

export {
  brandTheme,
  composeTheme,
  hasToken,
  mergeTheme,
  resolveToken,
  resolveTokenOr,
  withAlpha,
  withReducedMotion,
} from "./utils/index.js";
export type { DeepPartialTheme, ThemeOverrides, TokenPath, TokenValue } from "./utils/index.js";
