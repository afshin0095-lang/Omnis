/**
 * Surface — the themed container every other component is built on.
 *
 * WHY ONE PRIMITIVE FOR THIS
 * --------------------------
 * Background, border, radius, elevation and glass blur are the five properties that
 * decide whether an element reads as "part of the interface" or "floating above it".
 * Letting each component choose its own produces a page where three kinds of card
 * have three slightly different borders. Routing them all through one primitive
 * makes consistency the default and deviation explicit.
 *
 * The `glass` tone is the signature OMNIS surface: translucent, blurred, hairline
 * edged, designed to sit over the animated aurora background.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import {
  CSS_VARS,
  componentClass,
  ELEVATION_VAR,
  RADIUS_VAR,
  SPACE_VAR,
} from "../../utils/index.js";
import type { Elevation, RadiusScale, SpacingStep, SurfaceTone } from "../../types.js";

export interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  /** Element to render. Defaults to `div`. */
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  /** Which of the theme's surface colours to use. */
  tone?: SurfaceTone;
  /** Corner radius. Omitted means the element inherits whatever CSS gives it. */
  radius?: RadiusScale;
  /** Inner padding, as a step on the theme's spacing scale. */
  padding?: SpacingStep;
  /** Adds the theme's hairline border. */
  bordered?: boolean;
  /** Elevation shadow. `glow` is the OMNIS emission effect. */
  elevation?: Elevation;
}

/** Maps a tone onto the theme's surface colour. `transparent` means no background. */
const TONE_VAR: Readonly<Record<SurfaceTone, string | undefined>> = {
  base: CSS_VARS.surface,
  raised: CSS_VARS.surfaceRaised,
  glass: CSS_VARS.surfaceGlass,
  // A sunken surface recedes: it takes the page colour, which sits *behind* the
  // raised surfaces around it.
  sunken: CSS_VARS.background,
  transparent: undefined,
};

export function Surface({
  as,
  tone = "base",
  radius,
  padding,
  bordered = false,
  elevation = "none",
  className,
  style,
  children,
  ref,
  ...rest
}: SurfaceProps): ReactNode {
  const Tag = (as ?? "div") as ElementType;
  const glass = tone === "glass";

  const surfaceStyle: CSSProperties = {
    background: TONE_VAR[tone],
    color: CSS_VARS.text,
    fontFamily: CSS_VARS.fontSans,
    borderRadius: radius === undefined ? undefined : RADIUS_VAR[radius],
    padding: padding === undefined ? undefined : SPACE_VAR[padding],
    borderWidth: bordered ? "1px" : undefined,
    borderStyle: bordered ? "solid" : undefined,
    borderColor: bordered ? CSS_VARS.border : undefined,
    boxShadow: elevation === "none" ? undefined : ELEVATION_VAR[elevation],
    // Both prefixed and unprefixed: Safari still requires -webkit-backdrop-filter,
    // and omitting it silently drops the glass effect on the one browser where the
    // aurora behind it is most visible.
    backdropFilter: glass ? `blur(${CSS_VARS.glassBlur})` : undefined,
    WebkitBackdropFilter: glass ? `blur(${CSS_VARS.glassBlur})` : undefined,
  };

  return (
    <Tag
      ref={ref}
      data-omnis-surface={tone}
      className={componentClass("surface", { variant: tone, className })}
      style={{ ...surfaceStyle, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
