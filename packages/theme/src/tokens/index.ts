/**
 * Token scales.
 *
 * Each module owns one visual dimension. A theme composes them; a component reads
 * them through the theme, never directly — reading a scale directly is how a
 * component stops responding to a theme change.
 */

export {
  DARK_AURORA_LAYERS,
  DARK_COLORS,
  DARK_NEUTRALS,
  LIGHT_AURORA_LAYERS,
  LIGHT_COLORS,
  LIGHT_NEUTRALS,
  OMNIS_BLUE,
  OMNIS_CYAN,
  OMNIS_VIOLET,
  STATUS,
} from "./colors.js";
export { TYPOGRAPHY } from "./typography.js";
export { SPACING, SPACING_BASE_PX } from "./spacing.js";
export { RADIUS } from "./radius.js";
export { createShadows, DARK_SHADOWS, LIGHT_SHADOWS } from "./shadows.js";
export { MOTION, REDUCED_MOTION } from "./motion.js";
export { isKnownZIndex, Z_INDEX } from "./zIndex.js";
export {
  BREAKPOINT_NAMES,
  BREAKPOINTS,
  containerUp,
  mediaBetween,
  mediaDown,
  mediaOnly,
  mediaUp,
  nextBreakpoint,
} from "./breakpoints.js";
export type { BreakpointName } from "./breakpoints.js";
export { createSurfaces, DARK_SURFACES, LIGHT_SURFACES } from "./surface.js";
export { COMPONENTS } from "./components.js";
