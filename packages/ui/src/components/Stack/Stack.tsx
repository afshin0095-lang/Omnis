/**
 * Stack — the layout primitive.
 *
 * Spacing between siblings is the most common source of one-off `margin` rules, and
 * one-off margins are why a layout stops surviving change: the margin belongs to the
 * child, so reusing that child elsewhere carries the margin with it. A stack owns
 * the gap instead, which keeps children reusable and decides the rhythm once, where
 * the composition happens.
 *
 * `divider` interleaves a {@link Divider} between children — the accessible way to
 * separate a group of controls, since a border on each child would be visual only.
 */

import { Children, Fragment, isValidElement } from "react";
import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { Divider } from "../Divider/Divider.js";
import { componentClass, SPACE_VAR } from "../../utils/index.js";
import type { Alignment, Distribution, SpacingStep, StackDirection } from "../../types.js";

export interface StackProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  direction?: StackDirection;
  /** Gap between children, as a step on the theme's spacing scale. */
  gap?: SpacingStep;
  align?: Alignment;
  justify?: Distribution;
  wrap?: boolean;
  /** Inserts a divider between each pair of children. */
  divider?: boolean;
  /** Renders inline-flex rather than flex. */
  inline?: boolean;
}

/** Alignment shorthand to the flexbox `align-items` value. */
const ALIGN_VALUE: Readonly<Record<Alignment, string>> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

/** Distribution shorthand to the flexbox `justify-content` value. */
const JUSTIFY_VALUE: Readonly<Record<Distribution, string>> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

export function Stack({
  as,
  direction = "column",
  gap = 4,
  align,
  justify,
  wrap = false,
  divider = false,
  inline = false,
  className,
  style,
  children,
  ref,
  ...rest
}: StackProps): ReactNode {
  const Tag = (as ?? "div") as ElementType;

  const stackStyle: CSSProperties = {
    display: inline ? "inline-flex" : "flex",
    flexDirection: direction,
    gap: SPACE_VAR[gap],
    alignItems: align === undefined ? undefined : ALIGN_VALUE[align],
    justifyContent: justify === undefined ? undefined : JUSTIFY_VALUE[justify],
    flexWrap: wrap ? "wrap" : undefined,
  };

  const horizontal = direction === "row" || direction === "row-reverse";

  return (
    <Tag
      ref={ref}
      className={componentClass("stack", { variant: direction, className })}
      style={{ ...stackStyle, ...style }}
      {...rest}
    >
      {divider ? withDividers(children, horizontal ? "vertical" : "horizontal") : children}
    </Tag>
  );
}

/**
 * Interleaves dividers between the children that will actually render.
 *
 * `null`, `false` and `undefined` children are dropped first. React renders them as
 * nothing, so a conditional child that evaluated to `false` would otherwise still
 * receive a divider on each side — leaving two rules with nothing between them,
 * which is a visible bug that only appears when a feature flag is off.
 */
function withDividers(children: ReactNode, orientation: "horizontal" | "vertical"): ReactNode {
  // `isValidElement` is already a type guard, and it excludes null, booleans and
  // strings in one step — a hand-written predicate would have to name a supertype
  // of `Children.toArray`'s element type, which a narrowing guard cannot do.
  const present = Children.toArray(children).filter(isValidElement);

  return present.map((child, index) => (
    <Fragment key={index}>
      {index > 0 ? <Divider orientation={orientation} /> : null}
      {child}
    </Fragment>
  ));
}
