/**
 * Shared UI utilities.
 *
 * Three concerns that every component needs and none of them owns: composing class
 * names, composing refs, and naming the theme's CSS custom properties.
 */

export { blockClass, CLASS_PREFIX, cn, componentClass, elementClass } from "./cn.js";
export { composeRefs } from "./composeRefs.js";
export type { ComposableRef } from "./composeRefs.js";
export { CSS_VARS, cssVarNames } from "./cssVars.js";
export { ELEVATION_VAR, RADIUS_SCALES, RADIUS_VAR, SPACE_VAR, SPACING_STEPS } from "./scales.js";
export type { CssVarName } from "./cssVars.js";
