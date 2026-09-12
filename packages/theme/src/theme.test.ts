/**
 * Theme package tests.
 *
 * These assert the properties that make a theme *usable* rather than the values
 * inside it: completeness (no component may need a hard-coded fallback), identity
 * (themes must be distinguishable and resolvable), composition (a partial override
 * must yield a whole theme), and the CSS projection (including the aliases the
 * Studio stylesheet already reads).
 */

import { describe, expect, it } from "vitest";
import {
  AI_STUDIO_THEME,
  auroraBackground,
  brandTheme,
  BREAKPOINT_NAMES,
  BREAKPOINTS,
  composeTheme,
  containerUp,
  CSS_VARIABLE_PREFIX,
  DARK_THEME,
  DEFAULT_THEME,
  hasToken,
  isKnownThemeId,
  isKnownZIndex,
  LIGHT_THEME,
  mediaBetween,
  mediaDown,
  mediaOnly,
  mediaUp,
  mergeTheme,
  MOTION,
  nextBreakpoint,
  REDUCED_MOTION,
  resolveTheme,
  resolveToken,
  resolveTokenOr,
  THEMES,
  themeIds,
  themeToCss,
  themeToCssVariables,
  themeTokens,
  withAlpha,
  withReducedMotion,
  Z_INDEX,
} from "./index.js";
import type { Theme } from "./themes/types.js";

/** Token groups every theme must populate. */
const REQUIRED_GROUPS = [
  "colors",
  "typography",
  "spacing",
  "radius",
  "shadows",
  "motion",
  "zIndex",
  "breakpoints",
  "surfaces",
  "effects",
  "components",
] as const;

describe("theme catalogue", () => {
  it("ships dark, light and AI Studio themes", () => {
    expect(THEMES).toHaveLength(3);
    const schemes = new Set(THEMES.map((theme) => theme.colorScheme));
    expect(schemes.has("dark")).toBe(true);
    expect(schemes.has("light")).toBe(true);
  });

  it("gives every theme a unique id and a human-readable name", () => {
    const ids = THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of THEMES) {
      expect(theme.name.trim().length, theme.id).toBeGreaterThan(0);
    }
  });

  it("exposes themeIds() and isKnownThemeId() consistently", () => {
    expect(themeIds()).toEqual(THEMES.map((theme) => theme.id));
    for (const id of themeIds()) {
      expect(isKnownThemeId(id), id).toBe(true);
    }
    expect(isKnownThemeId("nope")).toBe(false);
  });

  it("defaults to the dark theme and boots the Studio with the AI Studio theme", () => {
    expect(DEFAULT_THEME).toBe(DARK_THEME);
    expect(resolveTheme(null)).toBe(DEFAULT_THEME);
    expect(resolveTheme(undefined)).toBe(DEFAULT_THEME);
    expect(resolveTheme(AI_STUDIO_THEME.id)).toBe(AI_STUDIO_THEME);
  });

  it("falls back to the default theme for an unknown id", () => {
    // A stale persisted preference must degrade to a working interface, not to a
    // blank screen.
    expect(resolveTheme("does-not-exist")).toBe(DEFAULT_THEME);
    expect(resolveTheme("omnis-light")).toBe(LIGHT_THEME);
  });
});

describe.each(THEMES.map((theme) => [theme.name, theme] as const))("%s", (_name, theme) => {
  it("populates every required token group", () => {
    for (const group of REQUIRED_GROUPS) {
      const value = theme[group] as unknown;
      expect(value, group).toBeTypeOf("object");
      expect(Object.keys(value as object).length, group).toBeGreaterThan(0);
    }
  });

  it("supplies every semantic colour role with a non-empty value", () => {
    for (const [role, value] of Object.entries(theme.colors)) {
      if (role === "aurora") {
        continue;
      }
      // A missing role means some component falls back to a hard-coded colour,
      // which is how a theme silently stops applying everywhere.
      expect(typeof value, role).toBe("string");
      expect((value as string).length, role).toBeGreaterThan(0);
    }
  });

  it("supplies an aurora ramp and at least three gradient layers", () => {
    expect(theme.colors.aurora).toHaveLength(3);
    expect(theme.effects.aurora.layers.length).toBeGreaterThanOrEqual(3);
    for (const layer of theme.effects.aurora.layers) {
      expect(layer.startsWith("radial-gradient("), layer).toBe(true);
    }
  });

  it("declares glass opacity within a usable range", () => {
    const { opacity, borderOpacity, blur } = theme.surfaces.glass;
    expect(opacity).toBeGreaterThanOrEqual(0);
    expect(opacity).toBeLessThanOrEqual(1);
    expect(borderOpacity).toBeGreaterThan(0);
    expect(borderOpacity).toBeLessThanOrEqual(1);
    expect(blur.endsWith("px")).toBe(true);
  });

  it("has motion durations that are valid CSS times", () => {
    for (const [key, value] of Object.entries(theme.motion.duration)) {
      expect(value, key).toMatch(/^\d+(\.\d+)?m?s$/);
    }
    for (const [key, value] of Object.entries(theme.motion.easing)) {
      expect(value, key).toMatch(/^cubic-bezier\(/);
    }
  });

  it("uses only layer indices from the shared z-index scale", () => {
    for (const [layer, value] of Object.entries(theme.zIndex)) {
      expect(isKnownZIndex(value), layer).toBe(true);
    }
  });

  it("projects to a prefixed custom property map covering every group", () => {
    const variables = themeToCssVariables(theme);
    const prefixed = Object.keys(variables).filter((key) =>
      key.startsWith(`${CSS_VARIABLE_PREFIX}-`),
    );
    expect(prefixed.length).toBeGreaterThan(60);
    expect(variables["--omnis-color-primary"]).toBe(theme.colors.primary);
    expect(variables["--omnis-scheme"]).toBe(theme.colorScheme);
    expect(variables["--omnis-id"]).toBe(theme.id);
    expect(variables["--omnis-space-4"]).toBe(theme.spacing[4]);
    expect(variables["--omnis-z-index-modal"]).toBe(String(theme.zIndex.modal));
    expect(variables["--omnis-breakpoint-lg"]).toBe(theme.breakpoints.lg);
    expect(variables["--omnis-motion-reduced"]).toBe(theme.motion.reduced ? "true" : "false");
  });

  it("renders a well-formed CSS block whose declarations are all terminated", () => {
    const selector = `[data-omnis-theme='${theme.id}']`;
    const css = themeToCss(theme, selector);
    expect(css.startsWith(`${selector} {`)).toBe(true);
    expect(css.endsWith("}")).toBe(true);
    const body = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(60);
    for (const line of lines) {
      // An unterminated declaration breaks every rule after it in the block.
      expect(line.endsWith(";"), line).toBe(true);
      expect(line.includes(": "), line).toBe(true);
    }
  });

  it("builds an aurora background that ends with the page colour", () => {
    const background = auroraBackground(theme);
    expect(background.endsWith(theme.colors.background)).toBe(true);
    expect(background.split("radial-gradient(").length - 1).toBe(
      theme.effects.aurora.layers.length,
    );
  });

  it("produces a token map whose keys are kebab-cased", () => {
    const tokens = themeTokens(theme);
    expect(tokens["color-background"]).toBe(theme.colors.background);
    expect(tokens["radius-md"]).toBe(theme.radius.md);
    expect(tokens["effect-orb-size"]).toBe(theme.effects.orb.size);
    expect(tokens["component-button-height-md"]).toBe(theme.components.button.height.md);
    for (const key of Object.keys(tokens)) {
      expect(key, key).not.toMatch(/[A-Z_]/);
    }
  });
});

describe("theme differentiation", () => {
  it("shares density and rhythm tokens between dark and light", () => {
    expect(DARK_THEME.typography).toBe(LIGHT_THEME.typography);
    expect(DARK_THEME.spacing).toBe(LIGHT_THEME.spacing);
    expect(DARK_THEME.radius).toBe(LIGHT_THEME.radius);
    expect(DARK_THEME.zIndex).toBe(LIGHT_THEME.zIndex);
    expect(DARK_THEME.breakpoints).toBe(LIGHT_THEME.breakpoints);
  });

  it("differs on colour, shadow and surface between dark and light", () => {
    expect(DARK_THEME.colors.background).not.toBe(LIGHT_THEME.colors.background);
    expect(DARK_THEME.colors.text).not.toBe(LIGHT_THEME.colors.text);
    expect(DARK_THEME.shadows.md).not.toBe(LIGHT_THEME.shadows.md);
    expect(DARK_THEME.surfaces.glass.opacity).not.toBe(LIGHT_THEME.surfaces.glass.opacity);
  });

  it("makes the AI Studio darker, more emissive and slower than the dark theme", () => {
    expect(AI_STUDIO_THEME.colorScheme).toBe("dark");
    expect(AI_STUDIO_THEME.id).not.toBe(DARK_THEME.id);
    expect(AI_STUDIO_THEME.colors.background).not.toBe(DARK_THEME.colors.background);
    expect(AI_STUDIO_THEME.effects.orb.size).not.toBe(DARK_THEME.effects.orb.size);
    expect(AI_STUDIO_THEME.effects.aurora.layers.length).toBeGreaterThan(
      DARK_THEME.effects.aurora.layers.length,
    );
    expect(AI_STUDIO_THEME.surfaces.glass.blur).not.toBe(DARK_THEME.surfaces.glass.blur);
    // Ambient motion is deliberately longer; interaction motion is not.
    expect(AI_STUDIO_THEME.motion.duration.deliberate).not.toBe(MOTION.duration.deliberate);
    expect(AI_STUDIO_THEME.motion.duration.fast).toBe(MOTION.duration.fast);
  });
});

describe("mergeTheme", () => {
  it("applies a nested override without mutating the base", () => {
    const branded = mergeTheme(DARK_THEME, { colors: { primary: "#ff00aa" } });
    expect(branded.colors.primary).toBe("#ff00aa");
    expect(DARK_THEME.colors.primary).not.toBe("#ff00aa");
    // Sibling tokens survive: a partial override must not punch holes.
    expect(branded.colors.secondary).toBe(DARK_THEME.colors.secondary);
    expect(branded.typography).toEqual(DARK_THEME.typography);
    expect(branded.id).toBe(DARK_THEME.id);
  });

  it("replaces arrays wholesale rather than merging by index", () => {
    const merged = mergeTheme(DARK_THEME, {
      colors: { aurora: ["#111111", "#222222", "#333333"] },
    });
    expect(merged.colors.aurora).toEqual(["#111111", "#222222", "#333333"]);
    expect(DARK_THEME.colors.aurora).not.toEqual(merged.colors.aurora);
  });

  it("ignores an explicitly undefined override", () => {
    const merged = mergeTheme(DARK_THEME, { colors: { primary: undefined } });
    expect(merged.colors.primary).toBe(DARK_THEME.colors.primary);
  });

  it("composes several overrides left to right", () => {
    const composed = composeTheme(
      DARK_THEME,
      { colors: { primary: "#aaaaaa", accent: "#bbbbbb" } },
      { colors: { primary: "#cccccc" } },
    );
    expect(composed.colors.primary).toBe("#cccccc");
    expect(composed.colors.accent).toBe("#bbbbbb");
  });

  it("derives a consistent glow when branding a theme", () => {
    const branded = brandTheme(DARK_THEME, { primary: "#ff8800" });
    expect(branded.id).toBe(`${DARK_THEME.id}-branded`);
    expect(branded.colors.primary).toBe("#ff8800");
    expect(branded.colors.primaryGlow).toBe("rgba(255, 136, 0, 0.35)");
    expect(branded.colors.borderFocus).toBe("rgba(255, 136, 0, 0.55)");
    // Everything else is inherited, so a tenant brand cannot accidentally break
    // an unrelated surface.
    expect(branded.spacing).toEqual(DARK_THEME.spacing);
  });

  it("honours an explicitly supplied glow colour", () => {
    const branded = brandTheme(DARK_THEME, { primary: "#ff8800", glow: "rgba(255, 136, 0, 0.9)" });
    expect(branded.colors.primaryGlow).toBe("rgba(255, 136, 0, 0.9)");
  });

  it("substitutes reduced motion", () => {
    const reduced = withReducedMotion(AI_STUDIO_THEME);
    expect(reduced.motion.reduced).toBe(true);
    expect(reduced.motion.duration.deliberate).toBe("0ms");
    // Easing survives: only durations collapse, so components can keep applying
    // transitions unconditionally.
    expect(reduced.motion.easing).toEqual(REDUCED_MOTION.easing);
    expect(reduced.colors).toEqual(AI_STUDIO_THEME.colors);
  });

  it("produces a theme that still projects to valid CSS", () => {
    const merged = mergeTheme(AI_STUDIO_THEME, { radius: { md: "4px" } });
    const variables = themeToCssVariables(merged);
    expect(variables["--omnis-radius-md"]).toBe("4px");
    expect(themeToCss(merged)).toContain("--omnis-radius-md: 4px;");
  });
});

describe("withAlpha", () => {
  it("converts six-digit hex to rgba", () => {
    expect(withAlpha("#57b6ff", 0.35)).toBe("rgba(87, 182, 255, 0.35)");
  });

  it("expands three-digit hex", () => {
    expect(withAlpha("#f80", 1)).toBe("rgba(255, 136, 0, 1)");
  });

  it("clamps alpha to the valid range", () => {
    expect(withAlpha("#000000", 2)).toBe("rgba(0, 0, 0, 1)");
    expect(withAlpha("#000000", -1)).toBe("rgba(0, 0, 0, 0)");
  });

  it("falls back to color-mix for formats it cannot parse", () => {
    // A malformed colour literal would drop the whole declaration; color-mix lets
    // the browser do the arithmetic instead.
    expect(withAlpha("rgb(1, 2, 3)", 0.5)).toBe(
      "color-mix(in srgb, rgb(1, 2, 3) 50%, transparent)",
    );
    expect(withAlpha("var(--x)", 0.25)).toBe("color-mix(in srgb, var(--x) 25%, transparent)");
  });
});

describe("resolveToken", () => {
  it("reads nested tokens and infers their type", () => {
    const primary: string = resolveToken(DARK_THEME, "colors.primary");
    expect(primary).toBe(DARK_THEME.colors.primary);
    expect(resolveToken(DARK_THEME, "motion.duration.fast")).toBe("150ms");
    expect(resolveToken(DARK_THEME, "zIndex.modal")).toBe(60);
    expect(resolveToken(DARK_THEME, "components.button.height.md")).toBe("40px");
    expect(resolveToken(DARK_THEME, "effects.orb.breatheScale")).toBeGreaterThan(1);
    expect(resolveToken(DARK_THEME, "colors.aurora")).toHaveLength(3);
  });

  it("reads top-level scalars", () => {
    expect(resolveToken(DARK_THEME, "id")).toBe("omnis-dark");
    expect(resolveToken(DARK_THEME, "colorScheme")).toBe("dark");
  });

  it("throws a descriptive error for a theme with a hole in it", () => {
    // Only reachable for a hand-built theme: the path itself is checked statically.
    const incomplete = { colors: {} } as unknown as Theme;
    expect(() => resolveToken(incomplete, "colors.primary")).toThrow(/colors\.primary/);
    expect(() => resolveToken(incomplete, "colors.primary")).toThrow(TypeError);
  });

  it("reports presence with hasToken", () => {
    expect(hasToken(DARK_THEME, "colors.primary")).toBe(true);
    expect(hasToken(DARK_THEME, "colors.nope")).toBe(false);
    expect(hasToken(DARK_THEME, "nope.deeper")).toBe(false);
  });

  it("falls back instead of throwing with resolveTokenOr", () => {
    const incomplete = { colors: {} } as unknown as Theme;
    expect(resolveTokenOr(incomplete, "colors.primary", "#ffffff")).toBe("#ffffff");
    expect(resolveTokenOr(DARK_THEME, "colors.primary", "#ffffff")).toBe(DARK_THEME.colors.primary);
  });
});

describe("breakpoints", () => {
  it("lists names in ascending order matching the scale", () => {
    const widths = BREAKPOINT_NAMES.map((name) => Number.parseFloat(BREAKPOINTS[name]));
    const sorted = [...widths].sort((a, b) => a - b);
    expect(widths).toEqual(sorted);
    expect(BREAKPOINTS.xs).toBe("0px");
  });

  it("builds inclusive lower-bound queries", () => {
    expect(mediaUp("md")).toBe("@media (min-width: 768px)");
    expect(containerUp("lg")).toBe("@container (min-width: 1024px)");
  });

  it("builds exclusive upper-bound queries with no one-pixel gap", () => {
    expect(mediaDown("md")).toBe("@media (max-width: 767.98px)");
    expect(mediaDown("xs")).toBe("@media (max-width: 0px)");
  });

  it("builds range and single-band queries", () => {
    expect(mediaBetween("sm", "lg")).toBe("@media (min-width: 640px) and (max-width: 1024px)");
    expect(mediaOnly("md")).toBe("@media (min-width: 768px) and (max-width: 1024px)");
    // The largest band has no upper neighbour, so it is open-ended.
    expect(mediaOnly("2xl")).toBe(mediaUp("2xl"));
    expect(nextBreakpoint("xl")).toBe("2xl");
    expect(nextBreakpoint("2xl")).toBeNull();
  });
});

describe("z-index scale", () => {
  it("is strictly ordered by intent", () => {
    const order = [
      Z_INDEX.base,
      Z_INDEX.content,
      Z_INDEX.raised,
      Z_INDEX.dropdown,
      Z_INDEX.sticky,
      Z_INDEX.overlay,
      Z_INDEX.modal,
      Z_INDEX.popover,
      Z_INDEX.toast,
      Z_INDEX.tooltip,
      Z_INDEX.max,
    ];
    for (let index = 1; index < order.length; index += 1) {
      const previous = order[index - 1];
      const current = order[index];
      expect(current, `layer ${index}`).toBeGreaterThan(previous as number);
    }
  });

  it("leaves room to insert a layer between any two neighbours", () => {
    const values = Object.values(Z_INDEX).sort((a, b) => a - b);
    for (let index = 1; index < values.length; index += 1) {
      const gap = (values[index] as number) - (values[index - 1] as number);
      expect(gap, `gap before ${values[index]}`).toBeGreaterThanOrEqual(10);
    }
  });

  it("recognises its own members", () => {
    expect(isKnownZIndex(Z_INDEX.tooltip)).toBe(true);
    expect(isKnownZIndex(9999)).toBe(false);
  });
});
