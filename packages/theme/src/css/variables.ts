/**
 * Turning a theme into CSS custom properties.
 *
 * WHY THIS IS A SEPARATE, EXPLICIT STEP
 * -------------------------------------
 * A theme is data; CSS is one of several ways to render that data. Keeping the
 * conversion here means the same `Theme` object can drive a web app, a canvas
 * renderer, a thumbnail generator or an email template, and it means switching a
 * theme at runtime is a matter of rewriting custom properties on the root element
 * — no stylesheet swap, no flash of unthemed content, no recompilation.
 *
 * NAMING
 * ------
 * `--omnis-<group>-<role>`, kebab-cased. The `omnis-` prefix is not decoration:
 * the Studio also loads third-party and legacy stylesheets, and an unprefixed
 * `--color-text` would collide with whichever of them declared it last.
 */

import type { Theme } from "../themes/types.js";

/** Prefix for every OMNIS custom property. */
export const CSS_VARIABLE_PREFIX = "--omnis";

/** Converts a camelCase or dotted token path to kebab-case. */
function kebab(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.]/g, "-")
    .toLowerCase();
}

/** Flattens a nested token object into `path -> value` pairs. */
function flatten(value: unknown, path: string[], out: Record<string, string>): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      flatten(entry, [...path, String(index)], out);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      flatten(entry, [...path, kebab(key)], out);
    }
    return;
  }
  out[path.map(kebab).join("-")] = String(value);
}

/**
 * Every custom property a theme produces, keyed without the prefix.
 *
 * Exposed separately from {@link themeToCssVariables} so a caller can inspect or
 * diff two themes without string manipulation.
 */
export function themeTokens(theme: Theme): Record<string, string> {
  const tokens: Record<string, string> = {};

  const groups: Record<string, unknown> = {
    color: theme.colors,
    font: theme.typography.fontFamily,
    "font-size": theme.typography.fontSize,
    "font-weight": theme.typography.fontWeight,
    "line-height": theme.typography.lineHeight,
    "letter-spacing": theme.typography.letterSpacing,
    space: theme.spacing,
    radius: theme.radius,
    shadow: theme.shadows,
    duration: theme.motion.duration,
    easing: theme.motion.easing,
    "z-index": theme.zIndex,
    breakpoint: theme.breakpoints,
    glass: theme.surfaces.glass,
    overlay: theme.surfaces.overlay,
    effect: theme.effects,
    component: theme.components,
  };

  for (const [group, value] of Object.entries(groups)) {
    flatten(value, [group], tokens);
  }

  // Scalars that have no natural group.
  tokens["scheme"] = theme.colorScheme;
  tokens["id"] = theme.id;
  tokens["motion-reduced"] = theme.motion.reduced ? "true" : "false";

  return tokens;
}

/**
 * The full custom-property map, prefixed and ready to assign to a style object.
 */
export function themeToCssVariables(theme: Theme): Record<string, string> {
  const variables: Record<string, string> = {};

  for (const [key, value] of Object.entries(themeTokens(theme))) {
    variables[`${CSS_VARIABLE_PREFIX}-${key}`] = value;
  }

  return variables;
}

/**
 * Renders a theme as a CSS rule block.
 *
 * Useful for server-side rendering a `<style>` tag, for generating a static
 * stylesheet at build time, or for injecting a tenant-specific theme into an
 * exported document.
 */
export function themeToCss(theme: Theme, selector = ":root"): string {
  const declarations = Object.entries(themeToCssVariables(theme))
    .map(([property, value]) => `  ${property}: ${value};`)
    .join("\n");
  return `${selector} {\n${declarations}\n}`;
}

/**
 * Renders the aurora background layers as a single CSS `background` value.
 *
 * Kept here rather than in a component because the layer list is theme data and a
 * component must not assume how many layers there are.
 */
export function auroraBackground(theme: Theme): string {
  return [...theme.effects.aurora.layers, theme.colors.background].join(", ");
}
