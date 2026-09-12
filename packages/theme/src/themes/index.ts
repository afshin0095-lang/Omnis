/**
 * Themes shipped with OMNIS, and theme resolution.
 *
 * `resolveTheme` falls back rather than throwing: a theme id arrives from
 * configuration or from a persisted user preference, and a stale or mistyped id
 * must degrade to a working interface, not to a blank screen. An unknown id is a
 * configuration problem to be logged by the caller, not a fatal one for the user
 * looking at the page.
 */

import type { Theme } from "./types.js";
import { AI_STUDIO_THEME } from "./aiStudio.js";
import { DARK_THEME } from "./dark.js";
import { LIGHT_THEME } from "./light.js";

export type { Theme } from "./types.js";
export { AI_STUDIO_AURORA_LAYERS, AI_STUDIO_COLORS, AI_STUDIO_THEME } from "./aiStudio.js";
export { DARK_THEME } from "./dark.js";
export { LIGHT_THEME } from "./light.js";

/** Every theme shipped with OMNIS, in picker order. */
export const THEMES: readonly Theme[] = [DARK_THEME, LIGHT_THEME, AI_STUDIO_THEME];

/** The theme used when nothing else is specified. */
export const DEFAULT_THEME: Theme = DARK_THEME;

/** The theme the Studio application boots with. */
export const STUDIO_THEME: Theme = AI_STUDIO_THEME;

/** Looks a theme up by id, falling back to {@link DEFAULT_THEME}. */
export function resolveTheme(id: string | null | undefined): Theme {
  if (id === null || id === undefined) {
    return DEFAULT_THEME;
  }
  return THEMES.find((theme) => theme.id === id) ?? DEFAULT_THEME;
}

/** True when `id` names a shipped theme. */
export function isKnownThemeId(id: string): boolean {
  return THEMES.some((theme) => theme.id === id);
}

/** Ids of every shipped theme, for populating a theme picker. */
export function themeIds(): string[] {
  return THEMES.map((theme) => theme.id);
}
