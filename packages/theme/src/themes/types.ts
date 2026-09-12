/**
 * The shape of an OMNIS theme.
 *
 * WHY A THEME IS DATA, NOT CODE
 * -----------------------------
 * §34 of the architecture requires themes to be runtime-configurable: a tenant
 * should eventually be able to choose or brand a Studio, and a character's own
 * visual identity should be able to influence the surfaces it appears on. Neither
 * is possible if a theme is a stylesheet that has to be recompiled and redeployed.
 *
 * So a theme is a plain, serializable value. `@omnis/theme` contains no React and
 * no CSS pipeline; it exports objects. Turning one into CSS custom properties is a
 * separate, explicit step (see `css.ts`), which means the same theme can drive a
 * web app, a canvas renderer, a thumbnail generator or an email template.
 *
 * SEMANTIC NAMES, NOT RAW COLOURS
 * -------------------------------
 * Roles are named for what they mean (`textMuted`, `surfaceRaised`, `danger`) and
 * never for what they look like (`grey400`, `blue`). A component that asks for
 * `textMuted` keeps working when a theme changes; a component that asks for
 * `grey400` is a theme change away from being wrong.
 */

/** A CSS colour value: hex, rgb(), rgba(), hsl() or a color-mix() expression. */
export type ColorValue = string;

/** A CSS length value, e.g. `"16px"` or `"1rem"`. */
export type LengthValue = string;

/** A CSS duration value, e.g. `"250ms"`. */
export type DurationValue = string;

/** Semantic colour roles. Every theme must supply all of them. */
export type ColorTokens = {
  /** Page background, behind everything. */
  readonly background: ColorValue;
  /** Default container background. */
  readonly surface: ColorValue;
  /** A container that sits above the default surface (cards, popovers). */
  readonly surfaceRaised: ColorValue;
  /** A translucent surface used for glass panels over animated backgrounds. */
  readonly surfaceGlass: ColorValue;
  /** A surface that is currently being interacted with. */
  readonly surfaceActive: ColorValue;

  readonly text: ColorValue;
  readonly textMuted: ColorValue;
  readonly textSubtle: ColorValue;
  /** Text placed on a `primary` background. */
  readonly textOnPrimary: ColorValue;

  readonly primary: ColorValue;
  /** Glow/emission colour derived from `primary`, used for the OMNIS orb and focus rings. */
  readonly primaryGlow: ColorValue;
  readonly secondary: ColorValue;
  readonly accent: ColorValue;

  readonly success: ColorValue;
  readonly warning: ColorValue;
  readonly danger: ColorValue;
  readonly info: ColorValue;

  readonly border: ColorValue;
  readonly borderSubtle: ColorValue;
  readonly borderFocus: ColorValue;

  /**
   * The three colours of the animated aurora background.
   *
   * Part of the theme rather than hard-coded in a component because the aurora is
   * the single most recognisable element of the OMNIS visual language, and a
   * re-branded Studio must be able to change it without editing a component.
   */
  readonly aurora: readonly [ColorValue, ColorValue, ColorValue];
};

/** Type scale and font stacks. */
export type TypographyTokens = {
  readonly fontFamily: {
    readonly sans: string;
    readonly heading: string;
    readonly mono: string;
  };
  readonly fontSize: {
    readonly xs: LengthValue;
    readonly sm: LengthValue;
    readonly base: LengthValue;
    readonly lg: LengthValue;
    readonly xl: LengthValue;
    readonly "2xl": LengthValue;
    readonly "3xl": LengthValue;
    readonly display: LengthValue;
  };
  readonly fontWeight: {
    readonly regular: number;
    readonly medium: number;
    readonly semibold: number;
    readonly bold: number;
  };
  readonly lineHeight: {
    readonly tight: number;
    readonly normal: number;
    readonly relaxed: number;
  };
  readonly letterSpacing: {
    readonly tight: string;
    readonly normal: string;
    readonly wide: string;
    readonly display: string;
  };
};

/** A spacing scale keyed by step, used for margin, padding and gap. */
export type SpacingTokens = {
  readonly 0: LengthValue;
  readonly 1: LengthValue;
  readonly 2: LengthValue;
  readonly 3: LengthValue;
  readonly 4: LengthValue;
  readonly 5: LengthValue;
  readonly 6: LengthValue;
  readonly 8: LengthValue;
  readonly 10: LengthValue;
  readonly 12: LengthValue;
  readonly 16: LengthValue;
};

/** Corner radii. */
export type RadiusTokens = {
  readonly none: LengthValue;
  readonly sm: LengthValue;
  readonly md: LengthValue;
  readonly lg: LengthValue;
  readonly xl: LengthValue;
  readonly pill: LengthValue;
};

/** Elevation and emission shadows. */
export type ShadowTokens = {
  readonly none: string;
  readonly sm: string;
  readonly md: string;
  readonly lg: string;
  /** Soft coloured glow, the signature OMNIS emission effect. */
  readonly glow: string;
  readonly glowStrong: string;
};

/** Timing and easing for animation. */
export type MotionTokens = {
  readonly duration: {
    readonly instant: DurationValue;
    readonly fast: DurationValue;
    readonly normal: DurationValue;
    readonly slow: DurationValue;
    /** Long-form motion, e.g. the breathing orb. */
    readonly deliberate: DurationValue;
  };
  readonly easing: {
    readonly standard: string;
    readonly emphasized: string;
    readonly decelerate: string;
    readonly accelerate: string;
  };
  /**
   * Whether motion should be suppressed.
   *
   * A theme-level flag rather than a component-level check so that
   * `prefers-reduced-motion` can be honoured by data, and so a kiosk or recording
   * environment can disable animation without touching components.
   */
  readonly reduced: boolean;
};

/** Translucent "glass" surface treatment. */
export type SurfaceTokens = {
  readonly glass: {
    readonly blur: LengthValue;
    readonly opacity: number;
    readonly borderOpacity: number;
  };
  readonly overlay: ColorValue;
};

/** Signature OMNIS visual effects. */
export type EffectTokens = {
  readonly aurora: {
    /** Radial gradient stops, as complete CSS `background` layers. */
    readonly layers: readonly string[];
  };
  readonly orb: {
    readonly size: LengthValue;
    readonly core: string;
    readonly breatheScale: number;
  };
};

/**
 * Layer ordering.
 *
 * A single shared scale rather than per-component `z-index` guesses. Stacking
 * conflicts are otherwise unfixable locally: the only way to put a toast above a
 * modal is to raise the toast, which then breaks the tooltip that must sit above
 * the toast. Deciding the order once, here, makes every such question answerable
 * by reading one list.
 *
 * Values are spaced by 10 so a future layer can be inserted between two existing
 * ones without renumbering everything above it.
 */
export type ZIndexTokens = {
  readonly base: number;
  readonly content: number;
  readonly raised: number;
  readonly dropdown: number;
  readonly sticky: number;
  readonly overlay: number;
  readonly modal: number;
  readonly popover: number;
  readonly toast: number;
  readonly tooltip: number;
  readonly max: number;
};

/**
 * Viewport min-widths.
 *
 * Breakpoints are theme data rather than component constants because the
 * responsive behaviour of a Studio is a design decision that a tenant-level theme
 * may legitimately need to adjust — a kiosk display and a phone want different
 * thresholds, and neither should require a component change.
 */
export type BreakpointTokens = {
  readonly xs: LengthValue;
  readonly sm: LengthValue;
  readonly md: LengthValue;
  readonly lg: LengthValue;
  readonly xl: LengthValue;
  readonly "2xl": LengthValue;
};

/** Per-component variant tokens. */
export type ComponentTokens = {
  readonly button: {
    readonly height: {
      readonly sm: LengthValue;
      readonly md: LengthValue;
      readonly lg: LengthValue;
    };
    readonly paddingX: {
      readonly sm: LengthValue;
      readonly md: LengthValue;
      readonly lg: LengthValue;
    };
  };
  readonly card: {
    readonly padding: LengthValue;
    readonly radius: LengthValue;
  };
  readonly panel: {
    readonly padding: LengthValue;
    readonly radius: LengthValue;
  };
};

/** Whether a theme targets a light or dark rendering environment. */
export type ColorScheme = "dark" | "light";

/** A complete, serializable OMNIS theme. */
export type Theme = {
  /** Stable identifier, e.g. `"omnis-dark"`. */
  readonly id: string;
  /** Human-readable name shown in a theme picker. */
  readonly name: string;
  readonly colorScheme: ColorScheme;
  readonly colors: ColorTokens;
  readonly typography: TypographyTokens;
  readonly spacing: SpacingTokens;
  readonly radius: RadiusTokens;
  readonly shadows: ShadowTokens;
  readonly motion: MotionTokens;
  readonly zIndex: ZIndexTokens;
  readonly breakpoints: BreakpointTokens;
  readonly surfaces: SurfaceTokens;
  readonly effects: EffectTokens;
  readonly components: ComponentTokens;
};
