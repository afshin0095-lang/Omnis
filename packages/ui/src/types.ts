/**
 * Prop types shared across the component library.
 *
 * Sizing and shape props are derived from the theme's own token types rather than
 * re-declared as string unions. `keyof SpacingTokens` means that adding a step to
 * the scale makes it available to every component automatically, and removing one
 * breaks every component that referenced it at compile time — which is the point.
 */

import type { RadiusTokens, SpacingTokens } from "@omnis/theme";

/** A step on the theme's spacing scale. */
export type SpacingStep = keyof SpacingTokens;

/** A step on the theme's radius scale. */
export type RadiusScale = keyof RadiusTokens;

/** Surface treatment. */
export type SurfaceTone = "base" | "raised" | "glass" | "sunken" | "transparent";

/** Elevation, mapped onto the theme's shadow scale. */
export type Elevation = "none" | "sm" | "md" | "lg" | "glow";

/**
 * Semantic colour intent.
 *
 * Named for meaning rather than appearance, so a component that says `tone="danger"`
 * stays correct when a theme changes what danger looks like.
 */
export type SemanticTone =
  "neutral" | "primary" | "secondary" | "accent" | "success" | "warning" | "danger" | "info";

/** Text colour intent. */
export type TextTone = "default" | "muted" | "subtle" | "inverse" | SemanticTone;

/** The three interactive sizes used consistently across controls. */
export type ControlSize = "sm" | "md" | "lg";

/** Layout direction for {@link Stack}. */
export type StackDirection = "row" | "column" | "row-reverse" | "column-reverse";

/** Alignment shorthand, mapped onto flexbox values. */
export type Alignment = "start" | "center" | "end" | "stretch" | "baseline";

/** Distribution shorthand, mapped onto flexbox values. */
export type Distribution = "start" | "center" | "end" | "between" | "around" | "evenly";

/** Placement of a floating element relative to its anchor. */
export type Placement = "top" | "right" | "bottom" | "left";
