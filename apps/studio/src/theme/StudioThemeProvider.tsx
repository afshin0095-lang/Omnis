/**
 * Owns the Studio's active theme.
 *
 * Separated from `@omnis/ui`'s `ThemeProvider` on purpose. The library provider
 * answers "what tokens are in effect?"; this one answers "which theme has the visitor
 * chosen, and what may they choose instead?" — application state, with persistence,
 * which has no business being in a component library.
 *
 * The two are composed rather than merged: this provider holds the id, resolves it to
 * a theme, and hands that theme to the library provider.
 */

import { ConfigurationError } from "@omnis/errors";
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ThemeProvider } from "@omnis/ui";
import type { Theme } from "@omnis/theme";
import {
  readStoredThemeId,
  resolveStudioTheme,
  STUDIO_THEMES,
  writeStoredThemeId,
} from "./studioTheme";

/** What the Studio exposes to its own screens. */
export interface StudioThemeContextValue {
  /** The theme in effect. */
  readonly theme: Theme;
  readonly themeId: string;
  /** Every theme the visitor may choose. */
  readonly available: readonly Theme[];
  /** Chooses a theme and persists the choice. */
  selectTheme(id: string): void;
}

const StudioThemeContext = createContext<StudioThemeContextValue | null>(null);

export interface StudioThemeProviderProps {
  children: ReactNode;
  /** Theme applied at bootstrap, so the provider starts from what is already painted. */
  initialTheme?: Theme;
}

export function StudioThemeProvider({
  children,
  initialTheme,
}: StudioThemeProviderProps): ReactNode {
  const [themeId, setThemeId] = useState<string>(
    () => initialTheme?.id ?? resolveStudioTheme(readStoredThemeId()).id,
  );

  const value = useMemo<StudioThemeContextValue>(() => {
    const theme = resolveStudioTheme(themeId);
    return {
      theme,
      themeId: theme.id,
      available: STUDIO_THEMES,
      selectTheme: (id: string) => {
        // Persist before applying: if the write fails the theme still changes for
        // this session, and the visitor is not left with a preference that silently
        // does not stick.
        writeStoredThemeId(id);
        setThemeId(id);
      },
    };
  }, [themeId]);

  return (
    <StudioThemeContext.Provider value={value}>
      <ThemeProvider theme={value.theme}>{children}</ThemeProvider>
    </StudioThemeContext.Provider>
  );
}

/** Reads the Studio's theme state. */
export function useStudioTheme(): StudioThemeContextValue {
  const context = useContext(StudioThemeContext);
  if (context === null) {
    throw new ConfigurationError(
      "useStudioTheme() was called outside a <StudioThemeProvider>. Wrap the application " +
        "root in StudioThemeProvider so screens share one theme selection.",
      { retryable: false },
    );
  }
  return context;
}
