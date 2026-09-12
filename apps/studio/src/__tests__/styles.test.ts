/**
 * The Studio stylesheet stays on tokens.
 *
 * `globals.css` is the one place in the frontend where a hard-coded colour would be
 * invisible to review and permanent in the output: it would survive every theme
 * switch and quietly break the light theme. These tests make that impossible.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BREAKPOINTS, BREAKPOINT_NAMES, THEMES, themeToCssVariables } from "@omnis/theme";
import { describe, expect, it } from "vitest";

/**
 * The authored stylesheet.
 *
 * Read from disk rather than imported: Vitest stubs CSS imports, and even `?raw` is
 * not exempt. Reading the file is also the more honest check — it asserts on what was
 * written, not on whatever a bundler happened to produce from it.
 */
const stylesheet = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");

/** Every px threshold appearing in a media query in the stylesheet. */
function mediaQueryWidths(css: string): number[] {
  const widths: number[] = [];
  for (const match of css.matchAll(/@media[^{]+/g)) {
    for (const width of match[0].matchAll(/(?:min|max)-width:\s*(\d+(?:\.\d+)?)px/g)) {
      if (width[1] !== undefined) {
        widths.push(Number.parseFloat(width[1]));
      }
    }
  }
  return widths;
}

/** The set of thresholds the theme's breakpoint scale permits. */
function permittedWidths(): Set<number> {
  const permitted = new Set<number>();
  for (const name of BREAKPOINT_NAMES) {
    const value = Number.parseFloat(BREAKPOINTS[name]);
    permitted.add(value);
    // `max-width` queries use the next breakpoint minus a hair, so that fractional
    // viewport widths match exactly one query.
    permitted.add(Number.parseFloat((value - 0.02).toFixed(2)));
  }
  return permitted;
}

describe("globals.css", () => {
  it("contains no hard-coded colours", () => {
    // Every colour must come from the theme, or the light and AI Studio themes will
    // render parts of the Studio in the dark theme's palette.
    expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(stylesheet).not.toMatch(/\brgba?\(/);
    expect(stylesheet).not.toMatch(/\bhsla?\(/);
  });

  it("takes its values from the theme's custom properties", () => {
    const references = [...stylesheet.matchAll(/var\((--omnis-[a-z0-9-]+)/g)].map(
      (match) => match[1],
    );
    expect(references.length).toBeGreaterThan(20);
    expect(new Set(references).size).toBeGreaterThan(10);
  });

  it("references only custom properties every theme actually publishes", () => {
    // A reference to a property one theme does not publish renders as an unresolvable
    // var() and silently drops the declaration — which is how a light theme ends up
    // with dark-theme spacing.
    const references = new Set(
      [...stylesheet.matchAll(/var\((--omnis-[a-z0-9-]+)/g)].map((match) => match[1] as string),
    );
    expect(references.size).toBeGreaterThan(10);

    for (const theme of THEMES) {
      const published = new Set(Object.keys(themeToCssVariables(theme)));
      const missing = [...references].filter((name) => !published.has(name));
      expect(missing, theme.id).toEqual([]);
    }
  });

  it("uses only thresholds from the theme's breakpoint scale", () => {
    // Media queries cannot use custom properties, so the widths are literals — which
    // is exactly why they are checked against the scale here.
    const permitted = permittedWidths();
    const used = mediaQueryWidths(stylesheet);
    expect(used.length).toBeGreaterThan(0);
    for (const width of used) {
      expect(permitted.has(width), `${width}px is not a theme breakpoint`).toBe(true);
    }
  });

  it("honours prefers-reduced-motion for the Studio's own effects", () => {
    // The component library collapses its own animations; the aurora and the orb are
    // authored here, so the preference has to be handled here too.
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    const reduced = stylesheet.slice(stylesheet.indexOf("prefers-reduced-motion"));
    expect(reduced).toContain(".aurora__layer");
    expect(reduced).toContain(".orb__core");
    expect(reduced).toContain(".studio-wordmark__glyph");
  });

  it("provides the visually-hidden utility the wordmark relies on", () => {
    // The animated glyphs are aria-hidden and the whole word is supplied separately;
    // without this class the accessible name would be invisible *and* take up space.
    expect(stylesheet).toContain(".visually-hidden");
    expect(stylesheet).toContain("clip-path: inset(50%)");
  });

  it("defines a document-wide focus ring", () => {
    expect(stylesheet).toContain(":focus-visible");
    expect(stylesheet).toContain("var(--omnis-color-border-focus)");
  });
});
