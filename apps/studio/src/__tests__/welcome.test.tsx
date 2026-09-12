/**
 * Studio integration tests.
 *
 * These render the real application: the real bootstrap theme, the real provider, the
 * real component library, the real effects. The question they answer is not "does this
 * component work" — `packages/ui` covers that — but "does the Studio actually consume
 * the theme and UI packages, and does the result hold up for a visitor using a
 * keyboard or a screen reader".
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AI_STUDIO_THEME, DARK_THEME, LIGHT_THEME } from "@omnis/theme";
import { ConfigurationError } from "@omnis/errors";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import { FOUNDATION_PACKAGES } from "../foundation";
import { TAGLINE } from "../components/branding/Tagline";
import { THEME_STORAGE_KEY } from "../theme/studioTheme";
import { useStudioTheme } from "../theme/StudioThemeProvider";
import type { ReactNode } from "react";

/** Reads a theme custom property from the document, as the running app would. */
function documentVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name).trim();
}

/** Renders the Studio with the AI Studio theme, as the bootstrap does. */
function renderStudio(): ReturnType<typeof render> {
  return render(<App initialTheme={AI_STUDIO_THEME} />);
}

describe("the welcome surface", () => {
  it("renders the OMNIS wordmark as the page's single top-level heading", () => {
    renderStudio();

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    // The per-glyph animation splits the word into spans; the accessible name must
    // still be one word rather than five announced characters.
    expect(headings[0]?.textContent).toContain("OMNIS");
    expect(screen.getByRole("heading", { level: 1, name: "OMNIS" })).toBeTruthy();
  });

  it("keeps the established tagline", () => {
    renderStudio();
    // Preserved copy: changing it is a brand decision, not an architecture one.
    expect(screen.getByText(TAGLINE)).toBeTruthy();
    expect(TAGLINE).toBe("Future Starts Today");
  });

  it("renders the aurora and the orb", () => {
    renderStudio();
    expect(screen.getByTestId("aurora")).toBeTruthy();
    expect(screen.getByTestId("orb")).toBeTruthy();
  });

  it("hides the decorative effects from assistive technology", () => {
    renderStudio();
    expect(screen.getByTestId("aurora").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("orb").getAttribute("aria-hidden")).toBe("true");
    // The animated glyphs are hidden and the whole word is supplied once instead.
    const wordmark = screen.getByTestId("wordmark");
    const hidden = wordmark.querySelector("span[aria-hidden='true']");
    expect(hidden).not.toBeNull();
    expect(hidden?.textContent).toBe("OMNIS");
  });

  it("renders one main landmark containing the content", () => {
    renderStudio();
    const main = screen.getByRole("main");
    expect(main).toBeTruthy();
    expect(within(main).getByRole("heading", { level: 1 })).toBeTruthy();
    // The aurora is a sibling of <main>, not inside it: decoration must not be part
    // of the content landmark.
    expect(within(main).queryByTestId("aurora")).toBeNull();
  });

  it("gives every control an accessible name", () => {
    renderStudio();
    const controls = screen.getAllByRole("button");
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const name = control.textContent?.trim() ?? control.getAttribute("aria-label") ?? "";
      expect(name.length, control.outerHTML.slice(0, 80)).toBeGreaterThan(0);
    }
  });

  it("publishes the foundation packages it actually ships", () => {
    renderStudio();
    const caption = screen.getByText(FOUNDATION_PACKAGES.join(" · "));
    expect(caption).toBeTruthy();
    expect(caption.textContent).toContain("@omnis/theme");
    expect(caption.textContent).toContain("@omnis/ui");
  });
});

describe("theme integration", () => {
  it("starts from the theme the bootstrap applied", () => {
    renderStudio();
    expect(document.documentElement.getAttribute("data-omnis-theme")).toBe(AI_STUDIO_THEME.id);
    expect(documentVar("--omnis-color-primary")).toBe(AI_STUDIO_THEME.colors.primary);
    expect(documentVar("--omnis-color-background")).toBe(AI_STUDIO_THEME.colors.background);
  });

  it("offers every Studio theme as a toggle with the active one pressed", () => {
    renderStudio();
    const toggles = screen
      .getAllByRole("button", { pressed: true })
      .concat(screen.getAllByRole("button", { pressed: false }));
    expect(toggles).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "OMNIS AI Studio" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "OMNIS Dark" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "OMNIS Light" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("re-themes the whole document when a theme is chosen", () => {
    renderStudio();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "OMNIS Light" }));
    });

    // This is the point of the runtime theme: one click, every surface, no reload.
    expect(document.documentElement.getAttribute("data-omnis-theme")).toBe(LIGHT_THEME.id);
    expect(documentVar("--omnis-color-primary")).toBe(LIGHT_THEME.colors.primary);
    expect(documentVar("--omnis-color-background")).toBe(LIGHT_THEME.colors.background);
    expect(documentVar("color-scheme")).toBe("light");
    expect(screen.getByRole("button", { name: "OMNIS Light" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("persists the choice so it survives a reload", () => {
    renderStudio();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "OMNIS Dark" }));
    });

    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe(DARK_THEME.id);
  });

  it("switches back and forth without leaving stale properties behind", () => {
    renderStudio();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "OMNIS Dark" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "OMNIS AI Studio" }));
    });

    expect(documentVar("--omnis-color-primary")).toBe(AI_STUDIO_THEME.colors.primary);
    // A token only the dark theme emphasises differently must follow the switch too.
    expect(documentVar("--omnis-duration-deliberate")).toBe(
      AI_STUDIO_THEME.motion.duration.deliberate,
    );
    expect(documentVar("--omnis-glass-blur")).toBe(AI_STUDIO_THEME.surfaces.glass.blur);
  });
});

describe("the theme inspector", () => {
  it("opens a dialog describing the theme in effect", () => {
    renderStudio();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Inspect this theme" }));
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("heading", { name: AI_STUDIO_THEME.name })).toBeTruthy();
    // The values are read from the theme object, not written into the page.
    expect(within(dialog).getByText(AI_STUDIO_THEME.id)).toBeTruthy();
    expect(within(dialog).getByText(AI_STUDIO_THEME.effects.orb.size)).toBeTruthy();
    expect(within(dialog).getByText(AI_STUDIO_THEME.motion.duration.deliberate)).toBeTruthy();
    expect(
      within(dialog).getByText(String(AI_STUDIO_THEME.effects.aurora.layers.length)),
    ).toBeTruthy();
  });

  it("lists every foundation package with its description", () => {
    renderStudio();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Inspect this theme" }));
    });

    const dialog = screen.getByRole("dialog");
    for (const name of FOUNDATION_PACKAGES) {
      expect(within(dialog).getByText(name), name).toBeTruthy();
    }
  });

  it("closes on Escape and on its own close button", () => {
    renderStudio();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Inspect this theme" }));
    });

    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Inspect this theme" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("returns focus to the control that opened it", () => {
    renderStudio();
    const trigger = screen.getByRole("button", { name: "Inspect this theme" });
    // `fireEvent.click` does not move focus the way a real click does, so the
    // trigger is focused explicitly: that is the state a keyboard or pointer user
    // is actually in when they activate it.
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      fireEvent.click(trigger);
    });
    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });

    expect(document.activeElement).toBe(trigger);
  });

  it("describes the newly selected theme after a switch", () => {
    renderStudio();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "OMNIS Dark" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Inspect this theme" }));
    });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: DARK_THEME.name })).toBeTruthy();
    expect(within(dialog).getByText(DARK_THEME.id)).toBeTruthy();
  });
});

describe("application wiring", () => {
  it("fails loudly when a screen reads the theme outside the provider", () => {
    function Orphan(): ReactNode {
      const { themeId } = useStudioTheme();
      return <span>{themeId}</span>;
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Orphan />)).toThrow(ConfigurationError);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("renders from a stored preference without an explicit initial theme", () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, LIGHT_THEME.id);
    render(<App />);
    expect(screen.getByRole("button", { name: "OMNIS Light" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("survives a stored preference it no longer recognises", () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, "omnis-theme-from-an-older-build");
    expect(() => render(<App />)).not.toThrow();
    expect(
      screen.getByRole("button", { name: "OMNIS AI Studio" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
