/**
 * ThemeProvider tests.
 *
 * These exercise the behaviour that is easy to get subtly wrong and impossible to
 * notice by looking at a screen: that the custom properties actually land on the
 * document, that switching a theme replaces them rather than layering over them,
 * that unmounting restores what was there before, and that the reduced-motion
 * preference is honoured live rather than only on first paint.
 */

import { render, screen, act } from "@testing-library/react";
import { AI_STUDIO_THEME, DARK_THEME, LIGHT_THEME, themeToCssVariables } from "@omnis/theme";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "@omnis/errors";
import { ThemeProvider, useTheme, useThemeTokens } from "./ThemeProvider.js";
import { Button } from "../components/Button/Button.js";
import { hasBaseStyles, OMNIS_BASE_CSS } from "../styles/index.js";

/** Reads a custom property from the document element. */
function documentVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name).trim();
}

/** A probe component that renders the theme id it was given. */
function ThemeProbe(): ReactNode {
  const { theme, reducedMotion, configured } = useTheme();
  return (
    <div>
      <span data-testid="effective">{theme.id}</span>
      <span data-testid="configured">{configured.id}</span>
      <span data-testid="reduced">{String(reducedMotion)}</span>
      <span data-testid="primary">{theme.colors.primary}</span>
    </div>
  );
}

afterEach(() => {
  // Leave the document clean for the next test.
  for (const name of Object.keys(themeToCssVariables(DARK_THEME))) {
    document.documentElement.style.removeProperty(name);
  }
  document.documentElement.removeAttribute("data-omnis-theme");
  document.documentElement.style.removeProperty("color-scheme");
});

describe("ThemeProvider", () => {
  it("publishes the theme as custom properties on the document element", () => {
    render(
      <ThemeProvider theme={DARK_THEME}>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(documentVar("--omnis-color-primary")).toBe(DARK_THEME.colors.primary);
    expect(documentVar("--omnis-color-background")).toBe(DARK_THEME.colors.background);
    expect(documentVar("--omnis-z-index-modal")).toBe(String(DARK_THEME.zIndex.modal));
  });

  it("marks the document with the theme id and colour scheme", () => {
    render(
      <ThemeProvider theme={LIGHT_THEME}>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(document.documentElement.getAttribute("data-omnis-theme")).toBe(LIGHT_THEME.id);
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");
  });

  it("resolves a theme given by id", () => {
    render(
      <ThemeProvider theme="omnis-ai-studio">
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("effective").textContent).toBe(AI_STUDIO_THEME.id);
    expect(documentVar("--omnis-color-primary")).toBe(AI_STUDIO_THEME.colors.primary);
  });

  it("defaults to the dark theme when no theme is given", () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("effective").textContent).toBe(DARK_THEME.id);
  });

  it("replaces rather than accumulates properties when the theme changes", () => {
    function Harness(): ReactNode {
      const [theme, setTheme] = useState(DARK_THEME);
      return (
        <>
          <button type="button" onClick={() => setTheme(AI_STUDIO_THEME)}>
            switch
          </button>
          <ThemeProvider theme={theme}>
            <ThemeProbe />
          </ThemeProvider>
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("effective").textContent).toBe(DARK_THEME.id);

    act(() => {
      screen.getByText("switch").click();
    });

    expect(screen.getByTestId("effective").textContent).toBe(AI_STUDIO_THEME.id);
    expect(documentVar("--omnis-color-primary")).toBe(AI_STUDIO_THEME.colors.primary);
    expect(document.documentElement.getAttribute("data-omnis-theme")).toBe(AI_STUDIO_THEME.id);
  });

  it("restores the document when it unmounts", () => {
    document.documentElement.style.setProperty("--omnis-color-primary", "rebeccapurple");

    const view = render(
      <ThemeProvider theme={DARK_THEME}>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(documentVar("--omnis-color-primary")).toBe(DARK_THEME.colors.primary);

    view.unmount();
    expect(documentVar("--omnis-color-primary")).toBe("rebeccapurple");
    expect(document.documentElement.getAttribute("data-omnis-theme")).toBeNull();
  });

  it("injects the library base stylesheet exactly once", () => {
    expect(hasBaseStyles()).toBe(false);

    render(
      <>
        <ThemeProvider theme={DARK_THEME}>
          <ThemeProbe />
        </ThemeProvider>
        <ThemeProvider theme={LIGHT_THEME}>
          <ThemeProbe />
        </ThemeProvider>
      </>,
    );

    expect(hasBaseStyles()).toBe(true);
    expect(document.querySelectorAll("style[data-omnis-ui-base]")).toHaveLength(1);
    expect(document.querySelector("style[data-omnis-ui-base]")?.textContent).toBe(OMNIS_BASE_CSS);
  });

  it("scopes a theme to a subtree instead of the document", () => {
    render(
      <ThemeProvider theme={DARK_THEME}>
        <ThemeProvider theme={AI_STUDIO_THEME} applyToDocument={false}>
          <ThemeProbe />
        </ThemeProvider>
      </ThemeProvider>,
    );

    // The document still carries the outer theme...
    expect(document.documentElement.getAttribute("data-omnis-theme")).toBe(DARK_THEME.id);
    // ...and the scoped subtree carries its own.
    const scope = document.querySelector<HTMLElement>("[data-omnis-theme-scope]");
    expect(scope).not.toBeNull();
    expect(scope?.getAttribute("data-omnis-theme-scope")).toBe(AI_STUDIO_THEME.id);
    expect(scope?.style.getPropertyValue("--omnis-color-primary").trim()).toBe(
      AI_STUDIO_THEME.colors.primary,
    );
    expect(screen.getByTestId("effective").textContent).toBe(AI_STUDIO_THEME.id);
  });

  it("does not touch the document when scoped", () => {
    const before = documentVar("--omnis-color-primary");
    const before2 = document.documentElement.getAttribute("data-omnis-theme");

    render(
      <ThemeProvider theme={AI_STUDIO_THEME} applyToDocument={false}>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(document.documentElement.getAttribute("data-omnis-theme")).toBe(before2);
    // Whatever the document carried before, a scoped provider must not change it.
    expect(documentVar("--omnis-color-primary")).toBe(before);
    expect(documentVar("--omnis-color-primary")).not.toBe(AI_STUDIO_THEME.colors.primary);
    // The scoped subtree still gets the theme it asked for.
    expect(screen.getByTestId("effective").textContent).toBe(AI_STUDIO_THEME.id);
  });
});

describe("reduced motion", () => {
  /** Installs a controllable matchMedia stub and returns a way to flip it. */
  function stubMatchMedia(initial: boolean): { set: (value: boolean) => void } {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    let matches = initial;

    const query = {
      get matches(): boolean {
        return matches;
      },
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void): void => {
        listeners.add(listener);
      },
      removeEventListener: (
        _type: string,
        listener: (event: { matches: boolean }) => void,
      ): void => {
        listeners.delete(listener);
      },
    };

    window.matchMedia = ((media: string) => {
      expect(media).toBe("(prefers-reduced-motion: reduce)");
      return query;
    }) as typeof window.matchMedia;

    return {
      set: (value: boolean) => {
        matches = value;
        for (const listener of listeners) {
          listener({ matches: value });
        }
      },
    };
  }

  it("substitutes the reduced-motion scale when the visitor asks for it", () => {
    stubMatchMedia(true);

    render(
      <ThemeProvider theme={AI_STUDIO_THEME}>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("reduced").textContent).toBe("true");
    // The configured theme is untouched, so a caller can still report what was asked
    // for versus what is being rendered.
    expect(screen.getByTestId("configured").textContent).toBe(AI_STUDIO_THEME.id);
    expect(documentVar("--omnis-duration-deliberate")).toBe("0ms");
    // Only durations collapse; the rest of the theme is unchanged.
    expect(documentVar("--omnis-color-primary")).toBe(AI_STUDIO_THEME.colors.primary);
  });

  it("responds to the preference changing mid-session", () => {
    const preference = stubMatchMedia(false);

    render(
      <ThemeProvider theme={DARK_THEME}>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("reduced").textContent).toBe("false");
    expect(documentVar("--omnis-duration-normal")).toBe(DARK_THEME.motion.duration.normal);

    act(() => {
      preference.set(true);
    });

    expect(screen.getByTestId("reduced").textContent).toBe("true");
    expect(documentVar("--omnis-duration-normal")).toBe("0ms");
  });

  it("ignores the preference when the caller opts out", () => {
    stubMatchMedia(true);

    render(
      <ThemeProvider theme={DARK_THEME} respectReducedMotion={false}>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("reduced").textContent).toBe("false");
    expect(documentVar("--omnis-duration-normal")).toBe(DARK_THEME.motion.duration.normal);
  });
});

describe("useTheme", () => {
  it("throws a ConfigurationError outside a provider", () => {
    // Falling back to a default would render the wrong theme silently; the failure
    // is a wiring bug and must be loud.
    function Orphan(): ReactNode {
      useTheme();
      return null;
    }

    // React logs the error to the console as well as throwing it.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Orphan />)).toThrow(ConfigurationError);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("exposes the effective theme through useThemeTokens", () => {
    function Probe(): ReactNode {
      const theme = useThemeTokens();
      return <span data-testid="token">{theme.colors.accent}</span>;
    }

    render(
      <ThemeProvider theme={AI_STUDIO_THEME}>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("token").textContent).toBe(AI_STUDIO_THEME.colors.accent);
  });

  it("does not require a provider for components that only use custom properties", () => {
    // This is the property that lets the library be adopted incrementally: a
    // component renders correctly whenever the variables exist, however they got
    // there.
    document.documentElement.style.setProperty("--omnis-color-primary", "rgb(1, 2, 3)");
    expect(() => render(<Button>Unprovided</Button>)).not.toThrow();
    expect(screen.getByRole("button", { name: "Unprovided" })).toBeTruthy();
  });
});
