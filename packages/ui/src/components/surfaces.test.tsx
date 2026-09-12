/**
 * Surface, layout and type tests.
 *
 * The property under test here is that appearance comes from theme custom
 * properties rather than from literals, and that each primitive stays semantic: a
 * `Text` rendered as a heading is a heading, a `Divider` is a separator, a `Stack`
 * with `divider` inserts real separators rather than borders.
 */

import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./Card/Card.js";
import { refCapture } from "../testing/refCapture.js";
import { Divider } from "./Divider/Divider.js";
import { EmptyState } from "./EmptyState/EmptyState.js";
import { Panel } from "./Panel/Panel.js";
import { Stack } from "./Stack/Stack.js";
import { Surface } from "./Surface/Surface.js";
import { Text } from "./Text/Text.js";

/** Reads an inline style property as the browser normalised it. */
function styleOf(element: HTMLElement, property: string): string {
  return element.style.getPropertyValue(property);
}

/**
 * Serialises a component to markup and returns its style attribute.
 *
 * Used for the handful of properties happy-dom drops from its CSSOM —
 * `-webkit-backdrop-filter` and `-webkit-line-clamp`. `react-dom/server` writes the
 * style attribute itself rather than going through a CSS object model, so this
 * asserts on the bytes a real browser receives instead of on what one particular DOM
 * implementation happens to model. Those two properties are the difference between
 * the glass effect working and silently not working on Safari, so they are worth
 * checking properly.
 */
function styleMarkup(element: ReactElement): string {
  const markup = renderToStaticMarkup(element);
  const match = /style="([^"]*)"/.exec(markup);
  return match?.[1] ?? "";
}

describe("Surface", () => {
  it("renders a div by default and accepts any element", () => {
    const { container } = render(<Surface data-testid="base">content</Surface>);
    expect(container.firstElementChild?.tagName).toBe("DIV");

    render(
      <Surface as="section" data-testid="section">
        content
      </Surface>,
    );
    expect(screen.getByTestId("section").tagName).toBe("SECTION");
  });

  it("resolves every tone to a theme custom property, never a literal", () => {
    const tones = ["base", "raised", "glass", "sunken", "transparent"] as const;
    for (const tone of tones) {
      const { container, unmount } = render(<Surface tone={tone} />);
      const element = container.firstElementChild as HTMLElement;
      expect(element.getAttribute("data-omnis-surface"), tone).toBe(tone);
      const background = styleOf(element, "background");
      if (tone === "transparent") {
        expect(background, tone).toBe("");
      } else {
        expect(background.startsWith("var(--omnis-color-"), `${tone}: ${background}`).toBe(true);
      }
      unmount();
    }
  });

  it("adds the blur treatment only for glass, with the Safari prefix too", () => {
    const glass = render(<Surface tone="glass" data-testid="glass" />);
    expect(styleOf(screen.getByTestId("glass"), "background")).toBe(
      "var(--omnis-color-surface-glass)",
    );
    const glassStyle = styleMarkup(<Surface tone="glass" />);
    expect(glassStyle).toContain("backdrop-filter:blur(var(--omnis-glass-blur))");
    // Safari ignores the unprefixed property; without this the glass effect simply
    // does not appear on the one browser where the aurora behind it is most visible.
    expect(glassStyle).toContain("-webkit-backdrop-filter:blur(var(--omnis-glass-blur))");
    glass.unmount();

    render(<Surface tone="raised" data-testid="solid" />);
    expect(styleMarkup(<Surface tone="raised" />)).not.toContain("backdrop-filter");
  });

  it("maps spacing, radius and elevation onto the theme scales", () => {
    render(<Surface padding={6} radius="lg" elevation="glow" bordered data-testid="styled" />);
    const element = screen.getByTestId("styled");
    expect(styleOf(element, "padding")).toBe("var(--omnis-space-6)");
    expect(styleOf(element, "border-radius")).toBe("var(--omnis-radius-lg)");
    expect(styleOf(element, "box-shadow")).toBe("var(--omnis-shadow-glow)");
    expect(styleOf(element, "border-color")).toBe("var(--omnis-color-border)");
    expect(styleOf(element, "border-top-width")).toBe("1px");
  });

  it("omits the properties it was not asked for", () => {
    render(<Surface data-testid="plain" />);
    const element = screen.getByTestId("plain");
    expect(styleOf(element, "padding")).toBe("");
    expect(styleOf(element, "border-radius")).toBe("");
    expect(styleOf(element, "box-shadow")).toBe("");
    expect(styleOf(element, "border")).toBe("");
  });

  it("lets the caller's style win", () => {
    render(<Surface data-testid="override" style={{ padding: "2px" }} />);
    expect(styleOf(screen.getByTestId("override"), "padding")).toBe("2px");
  });

  it("forwards a ref", () => {
    const captured = refCapture<HTMLElement>();
    render(<Surface ref={captured.ref} />);
    expect(captured.read()?.tagName).toBe("DIV");
  });
});

describe("Stack", () => {
  it("is a column flex container with a themed gap by default", () => {
    render(
      <Stack data-testid="stack">
        <span>a</span>
        <span>b</span>
      </Stack>,
    );
    const stack = screen.getByTestId("stack");
    expect(styleOf(stack, "display")).toBe("flex");
    expect(styleOf(stack, "flex-direction")).toBe("column");
    expect(styleOf(stack, "gap")).toBe("var(--omnis-space-4)");
  });

  it("maps alignment and distribution shorthand onto flexbox values", () => {
    render(
      <Stack
        data-testid="stack"
        direction="row"
        align="center"
        justify="between"
        wrap
        inline
        gap={2}
      >
        <span>a</span>
      </Stack>,
    );
    const stack = screen.getByTestId("stack");
    expect(styleOf(stack, "display")).toBe("inline-flex");
    expect(styleOf(stack, "flex-direction")).toBe("row");
    expect(styleOf(stack, "align-items")).toBe("center");
    expect(styleOf(stack, "justify-content")).toBe("space-between");
    expect(styleOf(stack, "flex-wrap")).toBe("wrap");
    expect(styleOf(stack, "gap")).toBe("var(--omnis-space-2)");
  });

  it("interleaves real separators between children", () => {
    render(
      <Stack divider data-testid="stack">
        <span>one</span>
        <span>two</span>
        <span>three</span>
      </Stack>,
    );
    // n children need n-1 separators; a border on each child would be visual only
    // and would not be announced.
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("orients the separators with the stack", () => {
    const column = render(
      <Stack divider data-testid="stack">
        <span>one</span>
        <span>two</span>
      </Stack>,
    );
    expect(screen.getByRole("separator").getAttribute("data-omnis-divider")).toBe("horizontal");
    column.unmount();

    render(
      <Stack direction="row" divider data-testid="stack">
        <span>one</span>
        <span>two</span>
      </Stack>,
    );
    const separator = screen.getByRole("separator");
    expect(separator.getAttribute("data-omnis-divider")).toBe("vertical");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("does not emit a separator for a child that did not render", () => {
    // A conditional child that evaluated to false must not leave two rules with
    // nothing between them — a bug that only appears when a flag is off.
    render(
      <Stack divider data-testid="stack">
        <span>one</span>
        {false}
        {null}
        <span>two</span>
      </Stack>,
    );
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("renders nothing extra when divider is off", () => {
    render(
      <Stack data-testid="stack">
        <span>one</span>
        <span>two</span>
      </Stack>,
    );
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
  });
});

describe("Text", () => {
  it("renders a paragraph by default", () => {
    const { container } = render(<Text>Body copy</Text>);
    expect(container.firstElementChild?.tagName).toBe("P");
    expect(screen.getByText("Body copy")).toBeTruthy();
  });

  it("separates typography from document structure", () => {
    // The look is a design choice; the heading level is a fact a screen reader
    // depends on. Both have to be independently settable.
    render(
      <Text as="h2" size="display" weight="bold" tracking="display">
        OMNIS
      </Text>,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "OMNIS" });
    expect(styleOf(heading, "font-size")).toBe("var(--omnis-font-size-display)");
    expect(styleOf(heading, "letter-spacing")).toBe("var(--omnis-letter-spacing-display)");
  });

  it("applies the display tracking automatically at display size", () => {
    render(
      <Text as="h1" size="display">
        Wordmark
      </Text>,
    );
    expect(styleOf(screen.getByRole("heading", { level: 1 }), "letter-spacing")).toBe(
      "var(--omnis-letter-spacing-display)",
    );
  });

  it("maps every tone onto a theme colour", () => {
    const tones = ["default", "muted", "subtle", "inverse", "primary", "danger"] as const;
    for (const tone of tones) {
      const { unmount } = render(
        <Text tone={tone} data-testid="text">
          x
        </Text>,
      );
      const colour = styleOf(screen.getByTestId("text"), "color");
      expect(colour.startsWith("var(--omnis-color-"), `${tone}: ${colour}`).toBe(true);
      expect(screen.getByTestId("text").getAttribute("data-omnis-text")).toBe(tone);
      unmount();
    }
  });

  it("uses the monospace stack on request", () => {
    render(
      <Text mono data-testid="mono">
        cmd_01
      </Text>,
    );
    expect(styleOf(screen.getByTestId("mono"), "font-family")).toBe("var(--omnis-font-mono)");
  });

  it("clamps to one line or to n lines", () => {
    const single = render(
      <Text truncate data-testid="text">
        long
      </Text>,
    );
    const element = screen.getByTestId("text");
    expect(styleOf(element, "white-space")).toBe("nowrap");
    expect(styleOf(element, "text-overflow")).toBe("ellipsis");
    single.unmount();

    render(
      <Text truncate={3} data-testid="text">
        long
      </Text>,
    );
    expect(styleMarkup(<Text truncate={3}>long</Text>)).toContain("-webkit-line-clamp:3");
    expect(styleMarkup(<Text truncate={3}>long</Text>)).toContain("line-clamp:3");
    expect(styleOf(screen.getByTestId("text"), "overflow")).toBe("hidden");
  });

  it("never carries a default margin", () => {
    // A primitive that ships a browser-default margin forces every consumer to
    // cancel it, and the cancellations are what make spacing inconsistent.
    render(<Text data-testid="text">x</Text>);
    expect(styleOf(screen.getByTestId("text"), "margin")).toBe("0px");
  });
});

describe("Divider", () => {
  it("is a separator by default", () => {
    render(<Divider />);
    const divider = screen.getByRole("separator");
    expect(divider.tagName).toBe("HR");
    expect(divider.getAttribute("aria-orientation")).toBeNull();
  });

  it("stays a separator when vertical, and says so", () => {
    render(<Divider orientation="vertical" />);
    const divider = screen.getByRole("separator");
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("data-omnis-divider")).toBe("vertical");
  });

  it("draws a single edge rather than the browser's four-sided inset border", () => {
    render(<Divider data-testid="divider" />);
    const divider = screen.getByTestId("divider");
    expect(styleOf(divider, "border-top-width")).toBe("1px");
    expect(styleOf(divider, "border-left-width")).toBe("0px");
    expect(styleOf(divider, "border-color")).toBe("var(--omnis-color-border)");
  });

  it("maps tone and spacing onto theme values", () => {
    render(<Divider tone="subtle" spacing={4} data-testid="divider" />);
    const divider = screen.getByTestId("divider");
    expect(styleOf(divider, "border-color")).toBe("var(--omnis-color-border-subtle)");
    expect(styleOf(divider, "margin")).toBe("var(--omnis-space-4) 0px");
  });
});

describe("Card", () => {
  it("composes Surface rather than restyling a div", () => {
    render(<Card data-testid="card">body</Card>);
    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-omnis-surface")).toBe("raised");
    expect(card.getAttribute("data-omnis-card")).toBe("static");
    expect(styleOf(card, "border-radius")).toBe("var(--omnis-radius-lg)");
  });

  it("can be a glass card and can be marked interactive", () => {
    render(
      <Card glass interactive data-testid="card">
        body
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-omnis-surface")).toBe("glass");
    expect(card.getAttribute("data-omnis-card")).toBe("interactive");
  });

  it("does not claim to be interactive on its own", () => {
    // `interactive` is presentation. A card that navigates must still be a link or a
    // button, or it is a control that cannot be reached by keyboard.
    render(
      <Card interactive data-testid="card" onClick={() => {}}>
        body
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card.getAttribute("role")).toBeNull();
    // Not focusable either: the flag is presentation, so a keyboard user is not
    // offered a control that does nothing.
    expect(card.tabIndex).toBe(-1);
  });

  it("renders the four subcomponents with their own elements", () => {
    render(
      <Card data-testid="card">
        <CardHeader action={<button type="button">More</button>}>
          <CardTitle>Character</CardTitle>
        </CardHeader>
        <CardContent>Aria is a night-shift analyst.</CardContent>
        <CardFooter>
          <button type="button">Save</button>
        </CardFooter>
      </Card>,
    );

    // The default title level is a real heading, so the card appears in a document
    // outline rather than being invisible to it.
    expect(screen.getByRole("heading", { level: 3, name: "Character" })).toBeTruthy();
    expect(screen.getByText("Aria is a night-shift analyst.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("lets the title level be corrected for its context", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle as="h2">Section card</CardTitle>
        </CardHeader>
      </Card>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Section card" })).toBeTruthy();
  });

  it("aligns footer actions as asked", () => {
    render(
      <Card>
        <CardFooter align="between" data-testid="footer">
          <span>a</span>
          <span>b</span>
        </CardFooter>
      </Card>,
    );
    expect(styleOf(screen.getByTestId("footer"), "justify-content")).toBe("space-between");
  });
});

describe("Panel", () => {
  it("is a glass surface by default", () => {
    render(<Panel data-testid="panel">content</Panel>);
    const panel = screen.getByTestId("panel");
    expect(panel.getAttribute("data-omnis-surface")).toBe("glass");
    expect(styleOf(panel, "backdrop-filter")).toBe("blur(var(--omnis-glass-blur))");
  });

  it("adds the emission shadow only when asked", () => {
    const plain = render(<Panel data-testid="panel">content</Panel>);
    expect(styleOf(screen.getByTestId("panel"), "box-shadow")).not.toBe("var(--omnis-shadow-glow)");
    plain.unmount();

    render(
      <Panel glow data-testid="panel">
        content
      </Panel>,
    );
    expect(styleOf(screen.getByTestId("panel"), "box-shadow")).toBe("var(--omnis-shadow-glow)");
  });

  it("can be opaque where the background must not show through", () => {
    render(
      <Panel opaque data-testid="panel">
        content
      </Panel>,
    );
    expect(screen.getByTestId("panel").getAttribute("data-omnis-surface")).toBe("raised");
  });

  it("renders a header with a real heading and a decorative rule", () => {
    render(
      <Panel
        title="Agent runtime"
        description="8 characters online"
        action={<button type="button">Refresh</button>}
      >
        content
      </Panel>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Agent runtime" })).toBeTruthy();
    expect(screen.getByText("8 characters online")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    // The rule under the header is decoration; announcing it would be noise.
    const rules = document.querySelectorAll("[data-omnis-surface] [aria-hidden='true']");
    expect(rules.length).toBeGreaterThan(0);
  });

  it("renders no header at all when none was supplied", () => {
    render(<Panel data-testid="panel">content</Panel>);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
  });
});

describe("EmptyState", () => {
  it("states the fact, the reason and the way out", () => {
    render(
      <EmptyState
        title="No clips yet"
        description="The Content Factory has not produced anything for this character."
        action={<button type="button">Start a run</button>}
      />,
    );

    expect(screen.getByRole("heading", { level: 3, name: "No clips yet" })).toBeTruthy();
    expect(
      screen.getByText("The Content Factory has not produced anything for this character."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a run" })).toBeTruthy();
  });

  it("hides the icon slot from assistive technology", () => {
    render(<EmptyState icon={<svg data-testid="icon" />} title="Nothing here" />);
    // The wrapper carries aria-hidden, so the graphic is not announced as content.
    expect(screen.getByTestId("icon").parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("icon").parentElement?.className).toBe("omnis-empty-state__icon");
  });

  it("renders no action row when there is no action", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector(".omnis-empty-state__actions")).toBeNull();
  });

  it("supports a secondary action and extra content", () => {
    render(
      <EmptyState
        title="Nothing here"
        action={<button type="button">Primary</button>}
        secondaryAction={<button type="button">Secondary</button>}
      >
        <span data-testid="extra">extra</span>
      </EmptyState>,
    );
    expect(screen.getByRole("button", { name: "Primary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Secondary" })).toBeTruthy();
    expect(screen.getByTestId("extra")).toBeTruthy();
  });

  it("is not a landmark", () => {
    // An empty state is content. role="status" would announce it on every page that
    // happens to load an empty list.
    render(<EmptyState title="Nothing here" />);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(
      screen.getByText("Nothing here").closest("[data-omnis-empty-state]")?.getAttribute("role"),
    ).toBeNull();
  });

  it("compacts for use inside a card", () => {
    render(<EmptyState compact title="Nothing here" data-testid="empty" />);
    expect(screen.getByTestId("empty").getAttribute("data-omnis-empty-state")).toBe("compact");
  });
});
