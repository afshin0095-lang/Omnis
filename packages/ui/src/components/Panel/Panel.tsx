/**
 * Panel — the signature OMNIS glass surface.
 *
 * A panel is a large structural surface: translucent, blurred, edged with a hairline
 * border, sitting over the animated aurora so the background shows through it. It is
 * what makes the Studio read as instrumentation around a live system rather than as
 * a document, and it is the reason the aurora exists at all.
 *
 * RELATIONSHIP TO `Card` AND `Surface`
 * ------------------------------------
 * `Surface` owns the raw treatment, `Card` is a small raised grouping, `Panel` is a
 * large glass one with an optional emission edge. All three resolve to the same
 * theme tokens, so they agree with each other in every theme.
 *
 * `glow` adds the theme's emission shadow. It is off by default because a page where
 * every panel glows has no hierarchy left — emission should mark the one surface the
 * operator is meant to be looking at.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { Surface } from "../Surface/Surface.js";
import { Text } from "../Text/Text.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { Elevation, RadiusScale, SpacingStep } from "../../types.js";

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  /** Optional heading rendered above a hairline separator. */
  title?: ReactNode;
  /** Optional supporting text under the title. */
  description?: ReactNode;
  /** Rendered on the trailing edge of the header. */
  action?: ReactNode;
  padding?: SpacingStep;
  radius?: RadiusScale;
  elevation?: Elevation;
  /** Adds the theme's emission shadow. */
  glow?: boolean;
  /** Solid rather than translucent, for surfaces that must not show the background. */
  opaque?: boolean;
}

export function Panel({
  as,
  title,
  description,
  action,
  padding = 6,
  radius = "lg",
  elevation = "md",
  glow = false,
  opaque = false,
  className,
  style,
  children,
  ref,
  ...rest
}: PanelProps): ReactNode {
  const hasHeader = title !== undefined || description !== undefined || action !== undefined;

  const panelStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: CSS_VARS.space4,
    // The emission is the theme's glow shadow; when `glow` is off the requested
    // elevation is used unchanged.
    boxShadow: glow ? CSS_VARS.shadowGlow : undefined,
  };

  return (
    <Surface
      as={as}
      ref={ref}
      tone={opaque ? "raised" : "glass"}
      radius={radius}
      padding={padding}
      elevation={glow ? "none" : elevation}
      bordered
      className={cn(blockClass("panel"), { [blockClass("panel", "glow")]: glow }, className)}
      style={{ ...panelStyle, ...style }}
      {...rest}
    >
      {hasHeader ? (
        <header className={elementClass("panel", "header")}>
          <div
            className={elementClass("panel", "header-text")}
            style={{ display: "flex", flexDirection: "column", gap: CSS_VARS.space1 }}
          >
            {title === undefined ? null : (
              <Text as="h2" size="xl" weight="semibold" tracking="tight">
                {title}
              </Text>
            )}
            {description === undefined ? null : (
              <Text size="sm" tone="muted">
                {description}
              </Text>
            )}
          </div>
          {action === undefined ? null : (
            <div className={elementClass("panel", "header-action")}>{action}</div>
          )}
        </header>
      ) : null}

      {hasHeader ? (
        <div
          aria-hidden="true"
          className={elementClass("panel", "rule")}
          style={{ height: 1, background: CSS_VARS.borderSubtle, flexShrink: 0 }}
        />
      ) : null}

      <div
        className={elementClass("panel", "body")}
        style={{ display: "flex", flexDirection: "column", gap: CSS_VARS.space4, minWidth: 0 }}
      >
        {children}
      </div>
    </Surface>
  );
}
