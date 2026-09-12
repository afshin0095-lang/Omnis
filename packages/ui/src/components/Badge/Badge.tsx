/**
 * Badge — a short status or classification label.
 *
 * COLOURS ARE DERIVED, NOT LISTED
 * -------------------------------
 * A badge needs a tinted background, a saturated foreground and a hairline border in
 * the same hue. Rather than hard-coding twenty-four colour literals, all three are
 * derived from the theme's single semantic colour with `color-mix()`. That keeps the
 * badge correct in every theme — including a tenant-branded one nobody has seen — and
 * means a theme that darkens `warning` for contrast reasons fixes the badge's text,
 * tint and border at once.
 *
 * SEMANTICS
 * ---------
 * A badge is a `<span>`: it labels whatever it sits next to and adds no structure of
 * its own. It deliberately does *not* set `role="status"` — that would announce every
 * badge on the page as a live region, which is noise. A badge whose value changes and
 * must be announced should be given `role="status"` by the caller, who knows whether
 * the change matters.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { ControlSize, SemanticTone } from "../../types.js";

export interface BadgeProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  tone?: SemanticTone;
  size?: ControlSize;
  /** Filled rather than tinted: the semantic colour as background. */
  solid?: boolean;
  /** Border and text only, no fill. */
  outline?: boolean;
  /** Renders a leading dot, for states that are recognisable by colour alone. */
  dot?: boolean;
}

const TONE_VAR: Readonly<Record<SemanticTone, string>> = {
  neutral: CSS_VARS.textMuted,
  primary: CSS_VARS.primary,
  secondary: CSS_VARS.secondary,
  accent: CSS_VARS.accent,
  success: CSS_VARS.success,
  warning: CSS_VARS.warning,
  danger: CSS_VARS.danger,
  info: CSS_VARS.info,
};

const SIZE_FONT: Readonly<Record<ControlSize, string>> = {
  sm: CSS_VARS.fontSizeXs,
  md: CSS_VARS.fontSizeSm,
  lg: CSS_VARS.fontSizeBase,
};

const SIZE_HEIGHT: Readonly<Record<ControlSize, string>> = {
  sm: "18px",
  md: "22px",
  lg: "28px",
};

/** Builds a translucent tint of a theme colour. */
function tint(colour: string, percent: number): string {
  return `color-mix(in srgb, ${colour} ${percent}%, transparent)`;
}

export function Badge({
  as,
  tone = "neutral",
  size = "md",
  solid = false,
  outline = false,
  dot = false,
  className,
  style,
  children,
  ref,
  ...rest
}: BadgeProps): ReactNode {
  const Tag = (as ?? "span") as ElementType;
  const colour = TONE_VAR[tone];

  const badgeStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: CSS_VARS.space1,
    height: SIZE_HEIGHT[size],
    paddingInline: CSS_VARS.space2,
    borderRadius: CSS_VARS.radiusPill,
    fontFamily: CSS_VARS.fontSans,
    fontSize: SIZE_FONT[size],
    fontWeight: CSS_VARS.fontWeightMedium,
    lineHeight: 1,
    letterSpacing: CSS_VARS.letterSpacingWide,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
    // `solid` wins over `outline` when both are set: a filled badge is the stronger
    // assertion, and silently downgrading it would hide the caller's intent.
    background: solid ? colour : outline ? "transparent" : tint(colour, 16),
    color: solid ? CSS_VARS.textOnPrimary : colour,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: outline || solid ? colour : tint(colour, 34),
  };

  return (
    <Tag
      ref={ref}
      data-omnis-badge={tone}
      className={cn(blockClass("badge"), blockClass("badge", tone), className)}
      style={{ ...badgeStyle, ...style }}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={elementClass("badge", "dot")}
          style={{
            width: "0.5em",
            height: "0.5em",
            borderRadius: CSS_VARS.radiusPill,
            background: solid ? CSS_VARS.textOnPrimary : "currentColor",
            flexShrink: 0,
          }}
        />
      ) : null}
      {children}
    </Tag>
  );
}
