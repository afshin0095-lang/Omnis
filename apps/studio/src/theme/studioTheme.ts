/**
 * The Studio's theme selection and bootstrap.
 *
 * WHY THE THEME IS APPLIED BEFORE `createRoot`
 * --------------------------------------------
 * A React provider applies its theme in an effect, which runs after the first paint.
 * On a dark interface that is one frame of white — visible on every single load, and
 * the kind of defect that is impossible to fix later without touching the bootstrap.
 *
 * So the theme is written to the document synchronously, in this module, before React
 * exists. The provider then takes over and keeps it in step with the visitor's
 * preference. Both paths go through `applyThemeToDocument`, so they cannot disagree
 * about what applying a theme means.
 *
 * WHY THE CHOICE IS PERSISTED
 * ---------------------------
 * A theme is a preference, not a route. Losing it on every reload turns "I set this
 * up" into "I set this up again", and the second time the visitor stops bothering.
 * `localStorage` is used because the preference must survive a reload without a
 * backend existing yet; the read is guarded because private-mode browsers throw on
 * access rather than returning null.
 */

import { AI_STUDIO_THEME, DARK_THEME, LIGHT_THEME, themeToCssVariables } from "@omnis/theme";
import type { Theme } from "@omnis/theme";
import { applyThemeToDocument } from "@omnis/ui";

/** Key under which the visitor's choice is persisted. */
export const THEME_STORAGE_KEY = "omnis.studio.theme";

/** Themes the Studio offers, in picker order. */
export const STUDIO_THEMES: readonly Theme[] = [AI_STUDIO_THEME, DARK_THEME, LIGHT_THEME];

/** The theme the Studio boots with: its own, not the product default. */
export const DEFAULT_STUDIO_THEME: Theme = AI_STUDIO_THEME;

/** Resolves a stored or requested id to a theme the Studio actually offers. */
export function resolveStudioTheme(id: string | null): Theme {
  if (id === null) {
    return DEFAULT_STUDIO_THEME;
  }
  // A stale id — from an older build, or hand-edited — falls back rather than
  // rendering the interface with no theme at all.
  return STUDIO_THEMES.find((theme) => theme.id === id) ?? DEFAULT_STUDIO_THEME;
}

/** Reads the persisted choice, tolerating a browser that forbids storage access. */
export function readStoredThemeId(): string | null {
  try {
    return globalThis.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Safari in private mode throws on access to localStorage. A theme preference
    // is not worth failing the boot over.
    return null;
  }
}

/** Persists the choice, tolerating a browser that forbids storage access. */
export function writeStoredThemeId(id: string): void {
  try {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // The theme still applies for this session; only the persistence is lost.
  }
}

/**
 * Applies the persisted theme to the document, synchronously.
 *
 * Called from `main.tsx` before `createRoot`. Returns the theme that was applied so
 * the provider can start from the same value instead of re-deriving it.
 */
export function applyBootstrapTheme(): Theme {
  const theme = resolveStudioTheme(readStoredThemeId());
  if (typeof document !== "undefined") {
    applyThemeToDocument(theme);
  }
  return theme;
}

/**
 * The variables a theme publishes, for diagnostics.
 *
 * Re-exported so the Studio's own inspection surfaces do not have to import
 * `@omnis/theme` directly just to count tokens.
 */
export function describeTheme(theme: Theme): {
  readonly id: string;
  readonly name: string;
  readonly colorScheme: string;
  readonly tokenCount: number;
} {
  return {
    id: theme.id,
    name: theme.name,
    colorScheme: theme.colorScheme,
    tokenCount: Object.keys(themeToCssVariables(theme)).length,
  };
}
