/**
 * Button — the primary interactive control.
 *
 * A REAL ELEMENT, NOT A STYLED DIV
 * --------------------------------
 * `Button` renders a `<button>` unless the caller replaces it with `as`. That buys
 * keyboard activation, focusability, `disabled` semantics and form participation for
 * free — none of which can be re-implemented on a `<div>` without reproducing a
 * surprising amount of browser behaviour, and all of which are silently missing when
 * someone does.
 *
 * `type` defaults to `"button"`. React's default is `"submit"`, so a button dropped
 * into any ancestor `<form>` submits it — a bug that is invisible in isolation and
 * destructive in a form.
 *
 * THE LOADING STATE IS `disabled`, NOT `aria-disabled`
 * ----------------------------------------------------
 * A button whose action is already in flight must not fire again: double-submission
 * is a correctness problem, not a cosmetic one. `disabled` removes it from the tab
 * order, which is the right trade while the work is in flight, and `aria-busy` tells
 * assistive technology why. The spinner replaces the leading icon rather than being
 * added beside it so the button does not change width and shift the layout.
 */

import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  ElementType,
  MouseEvent,
  ReactNode,
  Ref,
} from "react";
import { Spinner } from "../Spinner/Spinner.js";
import { ANIMATED_CLASS, FOCUSABLE_CLASS } from "../../styles/index.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { ControlSize } from "../../types.js";

/** Visual emphasis, from strongest to quietest. */
export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";

/**
 * The link attributes a button rendered as an anchor legitimately needs.
 *
 * `Button` is polymorphic: `as` replaces the element it renders, and the component
 * already refuses to emit button-only attributes (`type`, `disabled`) on a
 * non-button element. What it could not previously express in types was the other
 * half of that contract — an anchor needs `href`. These four are picked from React's
 * own anchor attribute type rather than re-declared, so they stay correct as React's
 * types evolve, and they are the only element-specific attributes the polymorphic
 * path adds.
 */
type ButtonLinkAttributes = Pick<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target" | "rel" | "download"
>;

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "as" | "ref">, ButtonLinkAttributes {
  as?: ElementType;
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Shows a spinner, blocks activation and marks the button busy. */
  loading?: boolean;
  /** Announced while loading. Defaults to the button's own text. */
  loadingLabel?: string;
  fullWidth?: boolean;
  /** Rendered before the label; replaced by the spinner while loading. */
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Adds the theme's emission shadow. For the one action a surface is built around. */
  glow?: boolean;
}

/** Height and horizontal padding per size, taken from the theme's component tokens. */
const SIZE_HEIGHT: Readonly<Record<ControlSize, string>> = {
  sm: CSS_VARS.componentButtonHeightSm,
  md: CSS_VARS.componentButtonHeightMd,
  lg: CSS_VARS.componentButtonHeightLg,
};

const SIZE_PADDING: Readonly<Record<ControlSize, string>> = {
  sm: CSS_VARS.componentButtonPaddingXSm,
  md: CSS_VARS.componentButtonPaddingXMd,
  lg: CSS_VARS.componentButtonPaddingXLg,
};

const SIZE_FONT: Readonly<Record<ControlSize, string>> = {
  sm: CSS_VARS.fontSizeSm,
  md: CSS_VARS.fontSizeBase,
  lg: CSS_VARS.fontSizeLg,
};

const SIZE_SPINNER: Readonly<Record<ControlSize, number>> = {
  sm: 12,
  md: 16,
  lg: 20,
};

/** Foreground and background per variant, all derived from theme colours. */
const VARIANT_STYLE: Readonly<
  Record<
    ButtonVariant,
    { readonly background: string; readonly color: string; readonly border: string }
  >
> = {
  primary: {
    background: CSS_VARS.primary,
    color: CSS_VARS.textOnPrimary,
    border: "transparent",
  },
  secondary: {
    background: CSS_VARS.surfaceActive,
    color: CSS_VARS.text,
    border: CSS_VARS.border,
  },
  outline: {
    background: "transparent",
    color: CSS_VARS.primary,
    border: CSS_VARS.primary,
  },
  ghost: {
    background: "transparent",
    color: CSS_VARS.textMuted,
    border: "transparent",
  },
  danger: {
    background: CSS_VARS.danger,
    color: CSS_VARS.textOnPrimary,
    border: "transparent",
  },
};

/**
 * The hover tint for a variant.
 *
 * Exported because a hover state cannot be expressed as an inline style, and a
 * consuming application that restyles buttons needs the same value this library
 * documents rather than a guess at it.
 */
export function buttonHoverBackground(variant: ButtonVariant): string {
  switch (variant) {
    case "primary":
    case "danger":
      return "color-mix(in srgb, currentColor 12%, transparent)";
    case "secondary":
      return CSS_VARS.surfaceActive;
    case "outline":
      return `color-mix(in srgb, ${CSS_VARS.primary} 12%, transparent)`;
    case "ghost":
      return CSS_VARS.surface;
  }
}

export function Button({
  as,
  variant = "primary",
  size = "md",
  loading = false,
  loadingLabel,
  fullWidth = false,
  iconLeft,
  iconRight,
  glow = false,
  disabled,
  type = "button",
  className,
  style,
  children,
  onClick,
  ref,
  ...rest
}: ButtonProps): ReactNode {
  const Tag = (as ?? "button") as ElementType;
  const inactive = disabled === true || loading;
  const variantStyle = VARIANT_STYLE[variant];

  const buttonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: CSS_VARS.space2,
    height: SIZE_HEIGHT[size],
    paddingInline: SIZE_PADDING[size],
    width: fullWidth ? "100%" : undefined,
    flexShrink: 0,
    border: `1px solid ${variantStyle.border}`,
    borderRadius: CSS_VARS.radiusPill,
    background: variantStyle.background,
    color: variantStyle.color,
    fontFamily: CSS_VARS.fontSans,
    fontSize: SIZE_FONT[size],
    fontWeight: CSS_VARS.fontWeightSemibold,
    letterSpacing: CSS_VARS.letterSpacingWide,
    lineHeight: 1,
    textTransform: "none",
    cursor: inactive ? "not-allowed" : "pointer",
    opacity: inactive ? 0.6 : 1,
    boxShadow: glow && !inactive ? CSS_VARS.shadowGlow : undefined,
    transition: `background ${CSS_VARS.durationFast} ${CSS_VARS.easingStandard}, box-shadow ${CSS_VARS.durationFast} ${CSS_VARS.easingStandard}, transform ${CSS_VARS.durationInstant} ${CSS_VARS.easingStandard}, opacity ${CSS_VARS.durationFast} ${CSS_VARS.easingStandard}`,
  };

  // A click that arrives while loading is dropped rather than forwarded. `disabled`
  // already prevents it in a browser, but this component can be rendered as a link
  // via `as`, where the attribute has no such effect.
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (inactive) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };

  return (
    <Tag
      ref={ref}
      type={Tag === "button" ? type : undefined}
      disabled={Tag === "button" ? disabled || loading : undefined}
      aria-busy={loading || undefined}
      aria-disabled={inactive || undefined}
      data-omnis-button={variant}
      data-loading={loading || undefined}
      className={cn(
        blockClass("button"),
        blockClass("button", variant),
        blockClass("button", size),
        FOCUSABLE_CLASS,
        ANIMATED_CLASS,
        {
          [blockClass("button", "full-width")]: fullWidth,
          [blockClass("button", "loading")]: loading,
        },
        className,
      )}
      style={{ ...buttonStyle, ...style }}
      onClick={handleClick}
      {...rest}
    >
      {loading ? (
        <Spinner
          size={SIZE_SPINNER[size]}
          label={loadingLabel ?? "Working"}
          tone={variant === "ghost" ? "neutral" : "primary"}
        />
      ) : (
        iconLeft
      )}
      {children === undefined ? null : (
        <span className={elementClass("button", "label")}>{children}</span>
      )}
      {iconRight}
    </Tag>
  );
}
