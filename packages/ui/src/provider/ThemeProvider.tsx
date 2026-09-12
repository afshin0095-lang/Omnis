/**
 * The theme provider.
 *
 * WHY CSS CUSTOM PROPERTIES AND NOT A STYLE OBJECT
 * ------------------------------------------------
 * Writing the theme to custom properties once, on a single element, means every
 * component can reference `var(--omnis-color-primary)` in a stylesheet and still
 * react to a theme change — without re-rendering, without a context read per
 * component, and without the flash that comes from swapping a stylesheet.
 *
 * The context is still provided, because a component sometimes needs the *value*
 * (a canvas renderer, a computed gradient, a `color-scheme` meta tag) rather than a
 * CSS reference.
 *
 * SERVER RENDERING
 * ----------------
 * Applying to `document` is a side effect and therefore belongs in `useEffect`,
 * never during render. During SSR the provider supplies the theme through context
 * and callers can render {@link themeToCss} into a `<style>` tag themselves, which
 * is why `applyToDocument` can be turned off: a scoped subtree can host a second
 * theme (a character's own visual identity) without overwriting the page's.
 */

import { ConfigurationError } from "@omnis/errors";
import { DEFAULT_THEME, REDUCED_MOTION, resolveTheme } from "@omnis/theme";
import type { Theme } from "@omnis/theme";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { injectBaseStyles } from "../styles/index.js";
import { applyThemeToDocument } from "./applyTheme.js";

/** Context value supplied by {@link ThemeProvider}. */
export interface ThemeContextValue {
  /** The theme as configured, before any user-preference adjustment. */
  readonly configured: Theme;
  /** The theme actually in effect, with reduced motion applied when requested. */
  readonly theme: Theme;
  /** True when the visitor asked for reduced motion and the provider honoured it. */
  readonly reducedMotion: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Props for {@link ThemeProvider}. */
export interface ThemeProviderProps {
  children: ReactNode;
  /** A theme object, or the id of one shipped with OMNIS. Defaults to the dark theme. */
  theme?: Theme | string;
  /**
   * Write the custom properties to `document.documentElement`.
   *
   * Set `false` to scope a theme to this subtree only; the provider then writes the
   * properties to its own wrapper element instead.
   */
  applyToDocument?: boolean;
  /**
   * Honour the visitor's `prefers-reduced-motion` setting by substituting
   * {@link REDUCED_MOTION}.
   *
   * On by default. Animation is central to the OMNIS look, which is precisely why
   * the option to turn it off must exist — a vestibular-disorder accommodation is
   * not a theme preference.
   */
  respectReducedMotion?: boolean;
}

/** Reads the OS-level reduced-motion preference, safely outside a browser. */
function readReducedMotionPreference(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Supplies a theme to a subtree and publishes it as CSS custom properties.
 */
export function ThemeProvider({
  children,
  theme,
  applyToDocument = true,
  respectReducedMotion = true,
}: ThemeProviderProps): ReactNode {
  const configured = useMemo<Theme>(
    () => (typeof theme === "string" ? resolveTheme(theme) : (theme ?? DEFAULT_THEME)),
    [theme],
  );

  const [prefersReduced, setPrefersReduced] = useState<boolean>(readReducedMotionPreference);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Track the preference while mounted: a visitor can change it mid-session and
  // the interface should respond without a reload.
  useEffect(() => {
    if (!respectReducedMotion) {
      setPrefersReduced(false);
      return;
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReduced(query.matches);
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersReduced(event.matches);
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, [respectReducedMotion]);

  const reducedMotion = respectReducedMotion && prefersReduced;
  const effective = useMemo<Theme>(
    () => (reducedMotion ? { ...configured, motion: REDUCED_MOTION } : configured),
    [configured, reducedMotion],
  );

  // The library's structural stylesheet (keyframes, focus ring, reduced-motion
  // override) is injected once per document. Deliberately not removed on unmount:
  // it is idempotent, harmless, and another provider elsewhere on the page may
  // still need it.
  useEffect(() => {
    if (applyToDocument) {
      injectBaseStyles();
    }
  }, [applyToDocument]);

  // Publish the theme. Runs after mount so it is skipped entirely during SSR; an
  // application that must avoid a flash of unthemed content calls
  // `applyThemeToDocument` in its bootstrap module, before `createRoot`.
  useEffect(() => {
    if (!applyToDocument) {
      return;
    }
    return applyThemeToDocument(effective) ?? undefined;
  }, [effective, applyToDocument]);

  // Publish a scoped theme onto the wrapper element instead of the document.
  useEffect(() => {
    if (applyToDocument) {
      return;
    }
    return applyThemeToDocument(effective, wrapperRef.current) ?? undefined;
  }, [effective, applyToDocument]);

  const value = useMemo<ThemeContextValue>(
    () => ({ configured, theme: effective, reducedMotion }),
    [configured, effective, reducedMotion],
  );

  // When scoping to a subtree a wrapper element is required to carry the custom
  // properties; when applying to the document the children are rendered directly
  // so no extra DOM node is introduced into someone else's layout.
  if (applyToDocument) {
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
  }
  return (
    <ThemeContext.Provider value={value}>
      <div ref={wrapperRef} data-omnis-theme-scope={effective.id}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

/**
 * Reads the theme in effect.
 *
 * @throws {ConfigurationError} when called outside a {@link ThemeProvider}.
 *   Falling back to a default here would be worse: a component would silently
 *   render with the wrong theme, and the mistake would only be noticed by a
 *   designer looking at a screenshot.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new ConfigurationError(
      "useTheme() was called outside a <ThemeProvider>. Wrap the subtree in a ThemeProvider " +
        "so components resolve their design tokens from a single source.",
      { retryable: false },
    );
  }
  return context;
}

/** Convenience accessor for the theme object alone. */
export function useThemeTokens(): Theme {
  return useTheme().theme;
}
