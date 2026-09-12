/**
 * `@omnis/ui` — the OMNIS shared React layer.
 *
 * WHAT BELONGS HERE
 * -----------------
 * Presentational components and the theme provider. Nothing else. No domain logic,
 * no data fetching, no knowledge of characters, content, publishing or any other
 * OMNIS bounded context: a component in this package must be usable by the Studio,
 * by an internal tool and by a rendered thumbnail without any of them leaking into
 * it.
 *
 * HOW THEMING WORKS
 * -----------------
 * `ThemeProvider` writes the active theme to CSS custom properties once, on the
 * document root. Components reference those properties; they do not read the theme
 * from context. Two consequences, both deliberate:
 *
 * - a theme switch re-themes the whole page without re-rendering a single component;
 * - every component renders correctly *without* a provider, as long as the custom
 *   properties are supplied by any means — which means the library can be adopted
 *   incrementally and can be server-rendered without a DOM.
 *
 * `useTheme` is exported for consumers that need a token *value* (a canvas renderer,
 * a computed gradient) rather than a CSS reference.
 *
 * Dependencies: `@omnis/theme`, `@omnis/errors`, `clsx`, `react`, `react-dom`.
 */

export { ThemeProvider, useTheme, useThemeTokens } from "./provider/ThemeProvider.js";
export type { ThemeProviderProps, ThemeContextValue } from "./provider/ThemeProvider.js";
export { applyThemeToDocument, THEME_ATTRIBUTE } from "./provider/applyTheme.js";

export * from "./components/index.js";

export {
  ANIMATED_CLASS,
  ANIMATIONS,
  BASE_STYLE_ATTRIBUTE,
  FOCUSABLE_CLASS,
  hasBaseStyles,
  injectBaseStyles,
  OMNIS_BASE_CSS,
  removeBaseStyles,
} from "./styles/index.js";
export type { AnimationName } from "./styles/index.js";

export {
  blockClass,
  CLASS_PREFIX,
  cn,
  componentClass,
  composeRefs,
  CSS_VARS,
  cssVarNames,
  elementClass,
  ELEVATION_VAR,
  RADIUS_SCALES,
  RADIUS_VAR,
  SPACE_VAR,
  SPACING_STEPS,
} from "./utils/index.js";
export type { ComposableRef, CssVarName } from "./utils/index.js";

export type {
  Alignment,
  ControlSize,
  Distribution,
  Elevation,
  Placement,
  RadiusScale,
  SemanticTone,
  SpacingStep,
  StackDirection,
  SurfaceTone,
  TextTone,
} from "./types.js";
