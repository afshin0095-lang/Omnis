/**
 * Progress — determinate and indeterminate progress.
 *
 * THE TWO MODES ARE NOT INTERCHANGEABLE
 * -------------------------------------
 * A determinate bar answers "how much is left"; an indeterminate one answers only
 * "something is happening". Reporting a fake percentage for work whose duration is
 * unknown is worse than reporting nothing, because a bar that sits at 90% for four
 * minutes teaches the operator to distrust every other bar in the product. So the
 * mode is derived from whether `value` is a finite number, and there is no prop for
 * inventing one.
 *
 * ACCESSIBILITY
 * -------------
 * `role="progressbar"` requires `aria-valuemin` and `aria-valuemax` always, and
 * `aria-valuenow` only when the value is known — omitting it in indeterminate mode is
 * the specification's own instruction, not an oversight. `aria-valuetext` is provided
 * when a caller has a better description than a number ("3 of 8 clips rendered"),
 * because "42" is meaningless without the unit.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { ANIMATED_CLASS, ANIMATIONS } from "../../styles/index.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { ControlSize, SemanticTone } from "../../types.js";

export interface ProgressProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  /** Current value. Omitted or non-finite means indeterminate. */
  value?: number | null;
  min?: number;
  max?: number;
  size?: ControlSize;
  tone?: SemanticTone;
  /** Accessible name. Required in practice: an unnamed progressbar announces as nothing. */
  label?: string;
  /** Spoken instead of the raw number, e.g. "3 of 8 clips rendered". */
  valueLabel?: string;
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

const TRACK_HEIGHT: Readonly<Record<ControlSize, string>> = {
  sm: "4px",
  md: "8px",
  lg: "12px",
};

/** Extracts a usable numeric value, or null when the bar must be indeterminate. */
function usableValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function Progress({
  as,
  value,
  min = 0,
  max = 100,
  size = "md",
  tone = "primary",
  label,
  valueLabel,
  className,
  style,
  ref,
  ...rest
}: ProgressProps): ReactNode {
  const Tag = (as ?? "div") as ElementType;
  const numeric = usableValue(value);
  const determinate = numeric !== null && max > min;
  // Clamped: a value outside the range would render a bar longer than its track,
  // which reads as a broken layout rather than as "finished".
  const clamped = numeric !== null && determinate ? Math.min(max, Math.max(min, numeric)) : min;
  const percent = determinate ? ((clamped - min) / (max - min)) * 100 : 0;
  const colour = TONE_VAR[tone];

  const trackStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    height: TRACK_HEIGHT[size],
    borderRadius: CSS_VARS.radiusPill,
    background: CSS_VARS.surfaceActive,
    overflow: "hidden",
    flexShrink: 0,
  };

  const barStyle: CSSProperties = determinate
    ? {
        position: "absolute",
        insetBlock: 0,
        insetInlineStart: 0,
        width: `${percent}%`,
        borderRadius: CSS_VARS.radiusPill,
        background: colour,
        boxShadow: `0 0 12px ${colour}`,
        // A determinate bar animates between values so that a jump from 10% to 60%
        // reads as progress rather than as a rendering glitch.
        transition: `width ${CSS_VARS.durationNormal} ${CSS_VARS.easingDecelerate}`,
      }
    : {
        position: "absolute",
        insetBlock: 0,
        insetInlineStart: 0,
        width: "30%",
        borderRadius: CSS_VARS.radiusPill,
        background: colour,
        boxShadow: `0 0 12px ${colour}`,
        animation: `${ANIMATIONS.indeterminate} ${CSS_VARS.durationSlow} ${CSS_VARS.easingStandard} infinite`,
      };

  return (
    <Tag
      ref={ref}
      role="progressbar"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={determinate ? clamped : undefined}
      aria-valuetext={determinate ? (valueLabel ?? `${Math.round(percent)}%`) : valueLabel}
      data-omnis-progress={determinate ? "determinate" : "indeterminate"}
      className={cn(blockClass("progress"), ANIMATED_CLASS, className)}
      style={style}
      {...rest}
    >
      <span aria-hidden="true" className={elementClass("progress", "track")} style={trackStyle}>
        <span className={elementClass("progress", "bar")} style={barStyle} />
      </span>
    </Tag>
  );
}
