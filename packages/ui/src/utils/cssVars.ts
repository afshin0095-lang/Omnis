/**
 * Typed references to the CSS custom properties a theme publishes.
 *
 * WHY COMPONENTS STYLE THROUGH VARIABLES
 * --------------------------------------
 * A component that reads `theme.colors.primary` from context and writes an inline
 * hex value re-renders on every theme change and cannot be styled by a consumer's
 * stylesheet. A component that writes `var(--omnis-color-primary)` is themed by the
 * provider once, reacts to a theme switch with no re-render at all, and can still be
 * overridden by a class rule in the consuming application.
 *
 * WHY A NAMED MAP RATHER THAN LITERAL STRINGS
 * -------------------------------------------
 * The property names are produced by `@omnis/theme`'s CSS projection. Writing them
 * as literals in fifteen components means a rename there silently breaks styling
 * here. `CSS_VARS` gives them one home, and `cssVars.test.ts` asserts that every
 * name in this map is actually emitted by the theme — which turns drift into a
 * failing test instead of a missing declaration.
 */

/** Every custom property this package consumes, as ready-to-use `var()` values. */
export const CSS_VARS = {
  // Colour roles
  background: "var(--omnis-color-background)",
  surface: "var(--omnis-color-surface)",
  surfaceRaised: "var(--omnis-color-surface-raised)",
  surfaceGlass: "var(--omnis-color-surface-glass)",
  surfaceActive: "var(--omnis-color-surface-active)",
  text: "var(--omnis-color-text)",
  textMuted: "var(--omnis-color-text-muted)",
  textSubtle: "var(--omnis-color-text-subtle)",
  textOnPrimary: "var(--omnis-color-text-on-primary)",
  primary: "var(--omnis-color-primary)",
  primaryGlow: "var(--omnis-color-primary-glow)",
  secondary: "var(--omnis-color-secondary)",
  accent: "var(--omnis-color-accent)",
  success: "var(--omnis-color-success)",
  warning: "var(--omnis-color-warning)",
  danger: "var(--omnis-color-danger)",
  info: "var(--omnis-color-info)",
  border: "var(--omnis-color-border)",
  borderSubtle: "var(--omnis-color-border-subtle)",
  borderFocus: "var(--omnis-color-border-focus)",

  // Typography
  fontSans: "var(--omnis-font-sans)",
  fontHeading: "var(--omnis-font-heading)",
  fontMono: "var(--omnis-font-mono)",
  fontSizeXs: "var(--omnis-font-size-xs)",
  fontSizeSm: "var(--omnis-font-size-sm)",
  fontSizeBase: "var(--omnis-font-size-base)",
  fontSizeLg: "var(--omnis-font-size-lg)",
  fontSizeXl: "var(--omnis-font-size-xl)",
  fontSize2xl: "var(--omnis-font-size-2xl)",
  fontSize3xl: "var(--omnis-font-size-3xl)",
  fontSizeDisplay: "var(--omnis-font-size-display)",
  fontWeightRegular: "var(--omnis-font-weight-regular)",
  fontWeightMedium: "var(--omnis-font-weight-medium)",
  fontWeightSemibold: "var(--omnis-font-weight-semibold)",
  fontWeightBold: "var(--omnis-font-weight-bold)",
  lineHeightTight: "var(--omnis-line-height-tight)",
  lineHeightNormal: "var(--omnis-line-height-normal)",
  lineHeightRelaxed: "var(--omnis-line-height-relaxed)",
  letterSpacingTight: "var(--omnis-letter-spacing-tight)",
  letterSpacingNormal: "var(--omnis-letter-spacing-normal)",
  letterSpacingWide: "var(--omnis-letter-spacing-wide)",
  letterSpacingDisplay: "var(--omnis-letter-spacing-display)",

  // Space, shape, elevation
  space0: "var(--omnis-space-0)",
  space1: "var(--omnis-space-1)",
  space2: "var(--omnis-space-2)",
  space3: "var(--omnis-space-3)",
  space4: "var(--omnis-space-4)",
  space5: "var(--omnis-space-5)",
  space6: "var(--omnis-space-6)",
  space8: "var(--omnis-space-8)",
  space10: "var(--omnis-space-10)",
  space12: "var(--omnis-space-12)",
  space16: "var(--omnis-space-16)",
  radiusNone: "var(--omnis-radius-none)",
  radiusSm: "var(--omnis-radius-sm)",
  radiusMd: "var(--omnis-radius-md)",
  radiusLg: "var(--omnis-radius-lg)",
  radiusXl: "var(--omnis-radius-xl)",
  radiusPill: "var(--omnis-radius-pill)",
  shadowNone: "var(--omnis-shadow-none)",
  shadowSm: "var(--omnis-shadow-sm)",
  shadowMd: "var(--omnis-shadow-md)",
  shadowLg: "var(--omnis-shadow-lg)",
  shadowGlow: "var(--omnis-shadow-glow)",
  shadowGlowStrong: "var(--omnis-shadow-glow-strong)",

  // Motion
  durationInstant: "var(--omnis-duration-instant)",
  durationFast: "var(--omnis-duration-fast)",
  durationNormal: "var(--omnis-duration-normal)",
  durationSlow: "var(--omnis-duration-slow)",
  durationDeliberate: "var(--omnis-duration-deliberate)",
  easingStandard: "var(--omnis-easing-standard)",
  easingEmphasized: "var(--omnis-easing-emphasized)",
  easingDecelerate: "var(--omnis-easing-decelerate)",
  easingAccelerate: "var(--omnis-easing-accelerate)",

  // Surfaces and layers
  glassBlur: "var(--omnis-glass-blur)",
  overlay: "var(--omnis-overlay)",
  zBase: "var(--omnis-z-index-base)",
  zContent: "var(--omnis-z-index-content)",
  zRaised: "var(--omnis-z-index-raised)",
  zDropdown: "var(--omnis-z-index-dropdown)",
  zSticky: "var(--omnis-z-index-sticky)",
  zOverlay: "var(--omnis-z-index-overlay)",
  zModal: "var(--omnis-z-index-modal)",
  zPopover: "var(--omnis-z-index-popover)",
  zToast: "var(--omnis-z-index-toast)",
  zTooltip: "var(--omnis-z-index-tooltip)",

  // Component dimensions shared across controls, so a button, an icon button and a
  // text field of the same size are actually the same height.
  componentButtonHeightSm: "var(--omnis-component-button-height-sm)",
  componentButtonHeightMd: "var(--omnis-component-button-height-md)",
  componentButtonHeightLg: "var(--omnis-component-button-height-lg)",
  componentButtonPaddingXSm: "var(--omnis-component-button-padding-x-sm)",
  componentButtonPaddingXMd: "var(--omnis-component-button-padding-x-md)",
  componentButtonPaddingXLg: "var(--omnis-component-button-padding-x-lg)",
  componentCardPadding: "var(--omnis-component-card-padding)",
  componentCardRadius: "var(--omnis-component-card-radius)",
  componentPanelPadding: "var(--omnis-component-panel-padding)",
  componentPanelRadius: "var(--omnis-component-panel-radius)",
} as const;

/** One key of {@link CSS_VARS}. */
export type CssVarName = keyof typeof CSS_VARS;

/** The raw custom-property names, without the `var()` wrapper. */
export function cssVarNames(): string[] {
  return Object.values(CSS_VARS).map((value) => value.slice("var(".length, -1));
}
