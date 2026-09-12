/**
 * Studio theme selection and bootstrap.
 *
 * The bootstrap path is the one that is easy to get wrong and impossible to see in a
 * unit test of the provider: it runs before React exists, so it has to be plain DOM
 * code, and it has to survive a browser that refuses storage access.
 */

import { AI_STUDIO_THEME, DARK_THEME, LIGHT_THEME, themeToCssVariables } from "@omnis/theme";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBootstrapTheme,
  DEFAULT_STUDIO_THEME,
  describeTheme,
  readStoredThemeId,
  resolveStudioTheme,
  STUDIO_THEMES,
  THEME_STORAGE_KEY,
  writeStoredThemeId,
} from "../theme/studioTheme";

beforeEach(() => {
  globalThis.localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-omnis-theme");
});

describe("the Studio's theme catalogue", () => {
  it("offers the AI Studio, dark and light themes", () => {
    expect(STUDIO_THEMES).toEqual([AI_STUDIO_THEME, DARK_THEME, LIGHT_THEME]);
  });

  it("boots with its own theme rather than the product default", () => {
    // The Studio is an instrumentation surface; the neutral dark theme is for editing.
    expect(DEFAULT_STUDIO_THEME).toBe(AI_STUDIO_THEME);
    expect(DEFAULT_STUDIO_THEME.id).toBe("omnis-ai-studio");
  });
});

describe("resolveStudioTheme", () => {
  it("resolves a known id", () => {
    expect(resolveStudioTheme("omnis-dark")).toBe(DARK_THEME);
    expect(resolveStudioTheme("omnis-light")).toBe(LIGHT_THEME);
    expect(resolveStudioTheme("omnis-ai-studio")).toBe(AI_STUDIO_THEME);
  });

  it("falls back for a null or unknown id", () => {
    // A stale preference from an older build must render a working interface, not a
    // blank one.
    expect(resolveStudioTheme(null)).toBe(DEFAULT_STUDIO_THEME);
    expect(resolveStudioTheme("")).toBe(DEFAULT_STUDIO_THEME);
    expect(resolveStudioTheme("omnis-retired-theme")).toBe(DEFAULT_STUDIO_THEME);
  });

  it("does not resolve a theme the Studio does not offer", () => {
    // `@omnis/theme` ships more themes than the Studio surfaces; resolving one of
    // those here would leave the switcher unable to show it as selected.
    const offered = new Set(STUDIO_THEMES.map((theme) => theme.id));
    expect(offered.has(resolveStudioTheme("omnis-dark").id)).toBe(true);
  });
});

describe("persisted preference", () => {
  it("round-trips through localStorage", () => {
    expect(readStoredThemeId()).toBeNull();
    writeStoredThemeId("omnis-light");
    expect(readStoredThemeId()).toBe("omnis-light");
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe("omnis-light");
  });

  it("tolerates a browser that forbids reading storage", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        // Safari in private mode throws on access rather than returning an empty store.
        throw new Error("denied");
      },
    });
    try {
      expect(readStoredThemeId()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  it("tolerates a browser that forbids writing storage", () => {
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      expect(() => writeStoredThemeId("omnis-dark")).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("applyBootstrapTheme", () => {
  it("paints the persisted theme onto the document before React starts", () => {
    writeStoredThemeId("omnis-dark");
    const theme = applyBootstrapTheme();

    expect(theme).toBe(DARK_THEME);
    expect(document.documentElement.getAttribute("data-omnis-theme")).toBe(DARK_THEME.id);
    expect(document.documentElement.style.getPropertyValue("--omnis-color-primary")).toBe(
      DARK_THEME.colors.primary,
    );
  });

  it("paints the Studio theme when nothing is persisted", () => {
    const theme = applyBootstrapTheme();
    expect(theme).toBe(AI_STUDIO_THEME);
    expect(document.documentElement.style.getPropertyValue("--omnis-color-background")).toBe(
      AI_STUDIO_THEME.colors.background,
    );
  });

  it("publishes a colour-scheme so native controls match", () => {
    applyBootstrapTheme();
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");
  });

  it("publishes every token the theme defines", () => {
    const theme = applyBootstrapTheme();
    const expected = themeToCssVariables(theme);
    for (const [property, value] of Object.entries(expected)) {
      expect(document.documentElement.style.getPropertyValue(property), property).toBe(value);
    }
  });
});

describe("describeTheme", () => {
  it("reports the theme's identity and token count", () => {
    const described = describeTheme(AI_STUDIO_THEME);
    expect(described).toEqual({
      id: "omnis-ai-studio",
      name: "OMNIS AI Studio",
      colorScheme: "dark",
      tokenCount: Object.keys(themeToCssVariables(AI_STUDIO_THEME)).length,
    });
    expect(described.tokenCount).toBeGreaterThan(60);
  });
});
