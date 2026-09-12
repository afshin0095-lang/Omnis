/**
 * Spinner — an indeterminate progress indicator.
 *
 * ACCESSIBILITY
 * -------------
 * `role="status"` with an `aria-label` makes the spinner announce itself once when
 * it appears, which is the whole point: a sighted user sees motion, a screen reader
 * user hears "Loading". The SVG itself is `aria-hidden`, because an animated graphic
 * whose meaning is already carried by the status role would be announced twice.
 *
 * MOTION
 * ------
 * The rotation is a CSS animation defined in the library's base stylesheet, and the
 * spinner carries the `omnis-animated` class. That stylesheet collapses animation
 * duration under `prefers-reduced-motion`, so a visitor who has asked for reduced
 * motion gets a static ring instead of a spinning one — the state is still conveyed,
 * because the label does the conveying, not the motion.
 *
 * An SVG ring rather than a bordered `<div>`: a div spinner needs a transparent
 * top border to look like an arc, which fails against any background that is not
 * flat, and the OMNIS background is an animated aurora.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { ANIMATED_CLASS, ANIMATIONS } from "../../styles/index.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { ControlSize, SemanticTone } from "../../types.js";

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  /** Diameter in pixels, or one of the shared control sizes. */
  size?: ControlSize | number;
  tone?: SemanticTone;
  /** Announced to assistive technology. Defaults to "Loading". */
  label?: string;
  /** Stroke width as a fraction of the diameter. */
  thickness?: number;
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

const NAMED_SIZE: Readonly<Record<ControlSize, number>> = {
  sm: 14,
  md: 20,
  lg: 28,
};

/** Diameter of the SVG viewbox; the ring is drawn to fill it. */
const VIEWBOX = 24;

export function Spinner({
  as,
  size = "md",
  tone = "primary",
  label = "Loading",
  thickness = 0.12,
  className,
  style,
  ref,
  ...rest
}: SpinnerProps): ReactNode {
  const Tag = (as ?? "span") as ElementType;
  const px = typeof size === "number" ? size : NAMED_SIZE[size];
  const stroke = Math.max(1, Math.round(VIEWBOX * thickness));
  // The arc covers a quarter of the ring: long enough to read as motion, short
  // enough that the rotation is visible.
  const radius = (VIEWBOX - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const spinnerStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: px,
    height: px,
    flexShrink: 0,
    color: TONE_VAR[tone],
  };

  return (
    <Tag
      ref={ref}
      role="status"
      aria-label={label}
      data-omnis-spinner={tone}
      className={cn(blockClass("spinner"), ANIMATED_CLASS, className)}
      style={{ ...spinnerStyle, ...style }}
      {...rest}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        width={px}
        height={px}
        className={elementClass("spinner", "ring")}
        style={{
          // One turn per `deliberate` duration: ambient enough to indicate progress
          // without strobing. The theme can lengthen it, which the AI Studio theme
          // does on purpose.
          animation: `${ANIMATIONS.spin} ${CSS_VARS.durationDeliberate} linear infinite`,
        }}
      >
        <circle
          cx={VIEWBOX / 2}
          cy={VIEWBOX / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.22}
          strokeWidth={stroke}
        />
        <circle
          cx={VIEWBOX / 2}
          cy={VIEWBOX / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.25} ${circumference * 0.75}`}
        />
      </svg>
    </Tag>
  );
}
