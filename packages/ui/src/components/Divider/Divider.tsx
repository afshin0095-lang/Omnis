/**
 * Divider — a semantic separator.
 *
 * Rendered as `<hr>` by default, which carries `role="separator"` implicitly. That
 * matters more than it looks: a screen reader user navigating a toolbar needs to
 * hear where one group of controls ends, and a border on a container conveys
 * nothing to them.
 *
 * A vertical divider is still an `<hr>` with `aria-orientation="vertical"` rather
 * than a `<div>`, so the semantics survive the change of direction.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { CSS_VARS, componentClass, SPACE_VAR } from "../../utils/index.js";
import type { SpacingStep } from "../../types.js";

export interface DividerProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  orientation?: "horizontal" | "vertical";
  /** `subtle` for grouping, `default` for separating sections, `strong` for a hard break. */
  tone?: "subtle" | "default" | "strong";
  /** Outer margin, as a step on the theme's spacing scale. */
  spacing?: SpacingStep;
}

/** Maps a tone onto a border colour. */
const TONE_VAR: Readonly<Record<NonNullable<DividerProps["tone"]>, string>> = {
  subtle: CSS_VARS.borderSubtle,
  default: CSS_VARS.border,
  strong: CSS_VARS.textSubtle,
};

export function Divider({
  as,
  orientation = "horizontal",
  tone = "default",
  spacing = 0,
  className,
  style,
  ref,
  ...rest
}: DividerProps): ReactNode {
  const Tag = (as ?? "hr") as ElementType;
  const vertical = orientation === "vertical";
  const colour = TONE_VAR[tone];
  const margin = SPACE_VAR[spacing];

  const dividerStyle: CSSProperties = {
    // `border: 0` first so only the one relevant edge is drawn; an <hr> otherwise
    // renders a browser-default inset border on all four sides.
    border: 0,
    borderStyle: "solid",
    borderColor: colour,
    ...(vertical
      ? {
          width: 0,
          borderLeftWidth: "1px",
          alignSelf: "stretch",
          margin: `0 ${margin}`,
          flexShrink: 0,
        }
      : {
          height: 0,
          borderTopWidth: "1px",
          width: "100%",
          margin: `${margin} 0`,
          flexShrink: 0,
        }),
  };

  return (
    <Tag
      ref={ref}
      aria-orientation={vertical ? "vertical" : undefined}
      data-omnis-divider={orientation}
      className={componentClass("divider", { variant: orientation, className })}
      style={{ ...dividerStyle, ...style }}
      {...rest}
    />
  );
}
