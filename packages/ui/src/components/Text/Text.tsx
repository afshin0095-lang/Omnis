/**
 * Text — the typography primitive.
 *
 * WHY A TEXT COMPONENT RATHER THAN RAW CSS CLASSES
 * ------------------------------------------------
 * Type is the most frequently mis-set property in an interface: a slightly wrong
 * size or a slightly wrong muted-grey accumulates until nothing on the page matches
 * anything else. Constraining the size, weight, tone and tracking to the theme's
 * scale means an author cannot produce an off-scale value without deliberately
 * reaching past the component.
 *
 * `as` exists because typography and semantics are independent. A heading's *look*
 * is a design choice; its *level* is a document-structure fact that a screen reader
 * depends on. Being able to render display-sized text as an `<h2>` — or body text as
 * a `<span>` inside a paragraph — is what lets both be correct at once.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { CSS_VARS, componentClass } from "../../utils/index.js";
import type { TextTone } from "../../types.js";

/** A step on the theme's type scale. */
export type TextSize = "xs" | "sm" | "base" | "lg" | "xl" | "2xl" | "3xl" | "display";

/** A step on the theme's weight scale. */
export type TextWeight = "regular" | "medium" | "semibold" | "bold";

/** Letter tracking. */
export type TextTracking = "tight" | "normal" | "wide" | "display";

export interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  size?: TextSize;
  weight?: TextWeight;
  tone?: TextTone;
  align?: "start" | "center" | "end" | "justify";
  tracking?: TextTracking;
  /** Uses the monospace stack — for identifiers, code and numeric readouts. */
  mono?: boolean;
  /**
   * Forwarded to the rendered element.
   *
   * Present because `HTMLAttributes` does not include it and a `Text` rendered
   * `as="label"` must be able to name the field it labels — which is the whole
   * reason the primitive is polymorphic.
   */
  htmlFor?: string;
  /**
   * Clamps to a single line, or to `n` lines when a number is given.
   *
   * Truncation is a visual decision with an accessibility cost: the hidden text is
   * still announced in full, so the visible and announced content disagree. Use it
   * where the full value is available elsewhere (a `title`, a tooltip, a detail
   * view), not as a way to avoid writing shorter copy.
   */
  truncate?: boolean | number;
}

const SIZE_VAR: Readonly<Record<TextSize, string>> = {
  xs: CSS_VARS.fontSizeXs,
  sm: CSS_VARS.fontSizeSm,
  base: CSS_VARS.fontSizeBase,
  lg: CSS_VARS.fontSizeLg,
  xl: CSS_VARS.fontSizeXl,
  "2xl": CSS_VARS.fontSize2xl,
  "3xl": CSS_VARS.fontSize3xl,
  display: CSS_VARS.fontSizeDisplay,
};

const WEIGHT_VAR: Readonly<Record<TextWeight, string>> = {
  regular: CSS_VARS.fontWeightRegular,
  medium: CSS_VARS.fontWeightMedium,
  semibold: CSS_VARS.fontWeightSemibold,
  bold: CSS_VARS.fontWeightBold,
};

const TRACKING_VAR: Readonly<Record<TextTracking, string>> = {
  tight: CSS_VARS.letterSpacingTight,
  normal: CSS_VARS.letterSpacingNormal,
  wide: CSS_VARS.letterSpacingWide,
  display: CSS_VARS.letterSpacingDisplay,
};

/**
 * Maps a tone onto a colour.
 *
 * `inverse` is the page background: on a filled primary button the text colour that
 * contrasts with the fill is the colour behind everything else, which is why it is
 * derived rather than hard-coded to white — a light theme needs dark text there.
 */
const TONE_VAR: Readonly<Record<TextTone, string>> = {
  default: CSS_VARS.text,
  muted: CSS_VARS.textMuted,
  subtle: CSS_VARS.textSubtle,
  inverse: CSS_VARS.textOnPrimary,
  neutral: CSS_VARS.textMuted,
  primary: CSS_VARS.primary,
  secondary: CSS_VARS.secondary,
  accent: CSS_VARS.accent,
  success: CSS_VARS.success,
  warning: CSS_VARS.warning,
  danger: CSS_VARS.danger,
  info: CSS_VARS.info,
};

export function Text({
  as,
  size = "base",
  weight = "regular",
  tone = "default",
  align,
  tracking,
  mono = false,
  truncate = false,
  className,
  style,
  children,
  ref,
  ...rest
}: TextProps): ReactNode {
  const Tag = (as ?? "p") as ElementType;
  const lines = typeof truncate === "number" ? truncate : truncate ? 1 : 0;

  const textStyle: CSSProperties = {
    margin: 0,
    fontFamily: mono ? CSS_VARS.fontMono : CSS_VARS.fontSans,
    fontSize: SIZE_VAR[size],
    fontWeight: WEIGHT_VAR[weight],
    color: TONE_VAR[tone],
    textAlign: align,
    letterSpacing:
      tracking !== undefined
        ? TRACKING_VAR[tracking]
        : size === "display"
          ? // The wordmark tracking is applied automatically at display size; the
            // existing Studio welcome surface sets it by hand, and every large
            // heading in the product wants the same treatment.
            TRACKING_VAR.display
          : undefined,
    lineHeight:
      size === "display" || size === "3xl" ? CSS_VARS.lineHeightTight : CSS_VARS.lineHeightNormal,
    ...(lines > 0
      ? lines === 1
        ? {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }
        : {
            overflow: "hidden",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: lines,
            lineClamp: lines,
          }
      : undefined),
  };

  return (
    <Tag
      ref={ref}
      data-omnis-text={tone}
      className={componentClass("text", { variant: size, className })}
      style={{ ...textStyle, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
