/**
 * The CSS projection of a theme.
 *
 * A theme is data; CSS is one way to render that data. Keeping the conversion in
 * its own module means the same `Theme` value can drive a web app, a canvas
 * renderer, a thumbnail generator or an exported document without any of them
 * depending on a stylesheet pipeline.
 */

export {
  auroraBackground,
  CSS_VARIABLE_PREFIX,
  themeToCss,
  themeToCssVariables,
  themeTokens,
} from "./variables.js";
