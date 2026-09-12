/**
 * Corner radii.
 *
 * `pill` is expressed as a large fixed length rather than `9999px` so that it
 * composes predictably inside `calc()` and does not produce the rendering
 * artefacts some engines show with absurd radii on short elements.
 */

import type { RadiusTokens } from "../themes/types.js";

export const RADIUS: RadiusTokens = {
  none: "0",
  sm: "6px",
  md: "16px",
  lg: "22px",
  xl: "32px",
  pill: "999px",
};
