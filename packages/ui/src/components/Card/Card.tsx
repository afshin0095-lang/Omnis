/**
 * Card — a raised surface that groups related content.
 *
 * Composed from {@link Surface} rather than restyling a `div`, so the card's
 * background, border and elevation are the theme's, not a second set of values that
 * drift from it.
 *
 * The subcomponents are exported separately instead of as `Card.Header` statics
 * because a static property cannot be tree-shaken and cannot be typed independently;
 * a consumer who wants only `CardContent` should not pay for the other three.
 *
 * SEMANTICS
 * ---------
 * `Card` renders a `<div>` and imposes no landmark role. A card is a visual grouping,
 * not a document structure, and inventing `role="region"` for every card floods a
 * screen reader's landmark list with entries the user did not ask for. A card that
 * genuinely is a landmark should be given one by the caller via `as="section"` plus an
 * accessible name.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { Surface } from "../Surface/Surface.js";
import { Text } from "../Text/Text.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { Elevation, RadiusScale, SpacingStep } from "../../types.js";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  padding?: SpacingStep;
  radius?: RadiusScale;
  elevation?: Elevation;
  /** Uses the translucent glass treatment instead of the raised surface. */
  glass?: boolean;
  /**
   * Marks the card as clickable.
   *
   * Presentation only — it adds the affordance, not the behaviour. A card that
   * navigates must still be a link or a button, or it is a control that cannot be
   * reached by keyboard. `Card` therefore never attaches a click handler of its own.
   */
  interactive?: boolean;
}

export function Card({
  as,
  padding = 6,
  radius = "lg",
  elevation = "sm",
  glass = false,
  interactive = false,
  className,
  style,
  children,
  ref,
  ...rest
}: CardProps): ReactNode {
  const cardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: CSS_VARS.space3,
    transition: `box-shadow ${CSS_VARS.durationFast} ${CSS_VARS.easingStandard}, transform ${CSS_VARS.durationFast} ${CSS_VARS.easingStandard}`,
  };

  return (
    <Surface
      as={as}
      ref={ref}
      tone={glass ? "glass" : "raised"}
      radius={radius}
      padding={padding}
      elevation={elevation}
      bordered
      data-omnis-card={interactive ? "interactive" : "static"}
      className={cn(
        blockClass("card"),
        { [blockClass("card", "interactive")]: interactive },
        className,
      )}
      style={{ ...cardStyle, ...style }}
      {...rest}
    >
      {children}
    </Surface>
  );
}

export interface CardHeaderProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  /** Rendered on the trailing edge, for a badge or a menu. */
  action?: ReactNode;
}

export function CardHeader({
  as,
  action,
  className,
  style,
  children,
  ref,
  ...rest
}: CardHeaderProps): ReactNode {
  const Tag = (as ?? "div") as ElementType;
  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: CSS_VARS.space3,
  };
  return (
    <Tag
      ref={ref}
      className={cn(elementClass("card", "header"), className)}
      style={{ ...headerStyle, ...style }}
      {...rest}
    >
      <div className={elementClass("card", "header-text")}>{children}</div>
      {action === undefined ? null : (
        <div className={elementClass("card", "header-action")}>{action}</div>
      )}
    </Tag>
  );
}

export interface CardTitleProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
}

/**
 * The card's title.
 *
 * Defaults to `<h3>` on the assumption that a page has one `<h1>` and cards sit
 * under a section `<h2>`. That assumption is wrong often enough that `as` is
 * available — but a default is still worth having, because an unlevelled title
 * rendered as a `<div>` is invisible to a document outline.
 */
export function CardTitle({
  as,
  className,
  style,
  children,
  ref,
  ...rest
}: CardTitleProps): ReactNode {
  return (
    <Text
      as={as ?? "h3"}
      ref={ref}
      size="lg"
      weight="semibold"
      tracking="tight"
      className={cn(elementClass("card", "title"), className)}
      style={style}
      {...rest}
    >
      {children}
    </Text>
  );
}

export interface CardContentProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
}

export function CardContent({
  as,
  className,
  style,
  children,
  ref,
  ...rest
}: CardContentProps): ReactNode {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag
      ref={ref}
      className={cn(elementClass("card", "content"), className)}
      style={{ display: "flex", flexDirection: "column", gap: CSS_VARS.space2, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export interface CardFooterProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  /** Aligns actions to the trailing edge. */
  align?: "start" | "center" | "end" | "between";
}

export function CardFooter({
  as,
  align = "end",
  className,
  style,
  children,
  ref,
  ...rest
}: CardFooterProps): ReactNode {
  const Tag = (as ?? "div") as ElementType;
  const justify =
    align === "start"
      ? "flex-start"
      : align === "center"
        ? "center"
        : align === "between"
          ? "space-between"
          : "flex-end";

  const footerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: justify,
    gap: CSS_VARS.space2,
    paddingTop: CSS_VARS.space2,
    borderTop: `1px solid ${CSS_VARS.borderSubtle}`,
  };

  return (
    <Tag
      ref={ref}
      className={cn(elementClass("card", "footer"), className)}
      style={{ ...footerStyle, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
