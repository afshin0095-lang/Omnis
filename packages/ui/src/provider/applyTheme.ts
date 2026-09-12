/**
 * Applying a theme to the document, outside React.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PROVIDER
 * --------------------------------------------
 * A provider applies its theme in an effect, which runs *after* the first paint.
 * For an application shell that is one frame of unthemed content — a white flash
 * before the dark Studio appears — and it is visible on every single load.
 *
 * An application can avoid that by applying the theme synchronously in its
 * bootstrap module, before `createRoot()`. That call has to be plain DOM code,
 * because React has not started yet. This function is that code, shared with the
 * provider so the two cannot disagree about what "applying a theme" means.
 *
 * It returns a restore function rather than an object with methods, because the only
 * thing a caller ever does with the result is call it on teardown.
 */

import { themeToCssVariables } from "@omnis/theme";
import type { Theme } from "@omnis/theme";

/** Attribute carrying the active theme id, for CSS selectors and for debugging. */
export const THEME_ATTRIBUTE = "data-omnis-theme";

/**
 * Writes a theme's custom properties onto `target`, defaulting to the document root.
 *
 * @returns a function that restores the target's previous values, or null when there
 *   is no document to write to.
 */
export function applyThemeToDocument(
  theme: Theme,
  target?: HTMLElement | null,
): (() => void) | null {
  if (typeof document === "undefined") {
    return null;
  }

  const element = target ?? document.documentElement;
  const variables = themeToCssVariables(theme);

  // Captured before writing, so unmounting one theme cannot leave another's values
  // behind — which is what happens when a scoped provider is nested inside a
  // document-level one.
  const previous = new Map<string, string>();
  for (const property of Object.keys(variables)) {
    previous.set(property, element.style.getPropertyValue(property));
  }
  const hadAttribute = element.hasAttribute(THEME_ATTRIBUTE);
  const previousAttribute = element.getAttribute(THEME_ATTRIBUTE);
  const previousScheme = element.style.getPropertyValue("color-scheme");

  for (const [property, value] of Object.entries(variables)) {
    element.style.setProperty(property, value);
  }
  element.setAttribute(THEME_ATTRIBUTE, theme.id);
  // Lets the browser pick correct form-control and scrollbar colours without the
  // theme having to enumerate them.
  element.style.setProperty("color-scheme", theme.colorScheme);

  return () => {
    for (const [property, value] of previous) {
      if (value === "") {
        element.style.removeProperty(property);
      } else {
        element.style.setProperty(property, value);
      }
    }
    if (hadAttribute && previousAttribute !== null) {
      element.setAttribute(THEME_ATTRIBUTE, previousAttribute);
    } else {
      element.removeAttribute(THEME_ATTRIBUTE);
    }
    if (previousScheme === "") {
      element.style.removeProperty("color-scheme");
    } else {
      element.style.setProperty("color-scheme", previousScheme);
    }
  };
}
