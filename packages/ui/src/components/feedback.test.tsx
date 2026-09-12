/**
 * Feedback component tests: Spinner, Progress, Badge.
 *
 * The failures these guard against are the ones that look fine on a screen: a
 * progress bar that reports a percentage nobody can verify, an indeterminate bar
 * that claims `aria-valuenow`, a status that is conveyed by colour alone.
 */

import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge/Badge.js";
import { Progress } from "./Progress/Progress.js";
import { Spinner } from "./Spinner/Spinner.js";

function styleOf(element: HTMLElement, property: string): string {
  return element.style.getPropertyValue(property);
}

/**
 * Serialises a component and returns its style attribute.
 *
 * happy-dom cannot parse `color-mix()` inside the `background` shorthand and drops
 * the declaration from its CSSOM. `react-dom/server` writes the attribute directly,
 * so this checks what a real browser receives — and every browser OMNIS supports
 * does parse `color-mix()`.
 */
function styleMarkup(element: ReactElement): string {
  const match = /style="([^"]*)"/.exec(renderToStaticMarkup(element));
  return match?.[1] ?? "";
}

describe("Spinner", () => {
  it("announces itself as a status with a default label", () => {
    render(<Spinner />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("Loading");
  });

  it("accepts a specific label", () => {
    render(<Spinner label="Rendering clip" />);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Rendering clip");
  });

  it("hides the graphic, because the status role already carries the meaning", () => {
    render(<Spinner />);
    const svg = screen.getByRole("status").querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    // `focusable=false` keeps legacy screen readers from tabbing into the graphic.
    expect(svg?.getAttribute("focusable")).toBe("false");
  });

  it("draws a ring with a visible arc rather than a full circle", () => {
    render(<Spinner />);
    const circles = screen.getByRole("status").querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    // The track is faint, the arc is a quarter turn: long enough to read as motion.
    expect(circles[0]?.getAttribute("stroke-opacity")).toBe("0.22");
    const dasharray = circles[1]?.getAttribute("stroke-dasharray") ?? "";
    const [arc, gap] = dasharray.split(" ").map(Number);
    expect(arc).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(arc ?? 0);
  });

  it("takes its colour and duration from the theme", () => {
    render(<Spinner tone="danger" data-testid="spinner" />);
    const spinner = screen.getByTestId("spinner");
    expect(styleOf(spinner, "color")).toBe("var(--omnis-color-danger)");
    const svg = spinner.querySelector("svg") as SVGElement;
    expect(svg.style.animation).toContain("omnis-spin");
    expect(svg.style.animation).toContain("var(--omnis-duration-deliberate)");
  });

  it("participates in the reduced-motion override", () => {
    render(<Spinner />);
    // The base stylesheet collapses animation for `.omnis-animated` under
    // prefers-reduced-motion; without the class the spinner would keep spinning for
    // a visitor who asked it not to.
    expect(screen.getByRole("status").className).toContain("omnis-animated");
  });

  it("sizes from the control scale or an explicit pixel value", () => {
    const named = render(<Spinner size="lg" data-testid="spinner" />);
    expect(styleOf(screen.getByTestId("spinner"), "width")).toBe("28px");
    named.unmount();

    render(<Spinner size={48} data-testid="spinner" />);
    expect(styleOf(screen.getByTestId("spinner"), "width")).toBe("48px");
  });

  it("never renders children, so it cannot be misused as a container", () => {
    render(<Spinner />);
    expect(screen.getByRole("status").children).toHaveLength(1);
  });
});

describe("Progress", () => {
  it("reports a determinate value with the full set of progressbar attributes", () => {
    render(<Progress value={40} label="Render progress" />);
    const bar = screen.getByRole("progressbar", { name: "Render progress" });
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-valuetext")).toBe("40%");
    expect(bar.getAttribute("data-omnis-progress")).toBe("determinate");
  });

  it("omits aria-valuenow when the value is unknown", () => {
    // Reporting a fake percentage for work of unknown duration is worse than
    // reporting nothing: a bar that sits at 90% for four minutes teaches the
    // operator to distrust every other bar in the product.
    render(<Progress label="Working" />);
    const bar = screen.getByRole("progressbar", { name: "Working" });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("data-omnis-progress")).toBe("indeterminate");
  });

  it("treats a non-finite value as indeterminate rather than as zero", () => {
    render(<Progress value={Number.NaN} label="Working" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  });

  it("honours a custom range", () => {
    render(<Progress value={5} min={2} max={8} label="Clips" />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("8");
    expect(bar.getAttribute("aria-valuenow")).toBe("5");
    // 5 of 2..8 is 50% of the way through the range, not 5%.
    expect(bar.getAttribute("aria-valuetext")).toBe("50%");
  });

  it("clamps an out-of-range value instead of overflowing the track", () => {
    const over = render(<Progress value={140} label="Over" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    over.unmount();

    render(<Progress value={-20} label="Under" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("reports a degenerate range as indeterminate rather than dividing by zero", () => {
    render(<Progress value={5} min={10} max={10} label="Broken" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  });

  it("speaks a caller-supplied description instead of a bare number", () => {
    render(<Progress value={3} max={8} label="Clips" valueLabel="3 of 8 clips rendered" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
      "3 of 8 clips rendered",
    );
  });

  it("animates the indeterminate bar and sizes the determinate one by percentage", () => {
    const indeterminate = render(<Progress label="Working" data-testid="progress" />);
    const indeterminateBar = screen
      .getByTestId("progress")
      .querySelector(".omnis-progress__bar") as HTMLElement;
    expect(indeterminateBar.style.animation).toContain("omnis-indeterminate");
    indeterminate.unmount();

    render(<Progress value={25} label="Working" data-testid="progress" />);
    const bar = screen.getByTestId("progress").querySelector(".omnis-progress__bar") as HTMLElement;
    expect(bar.style.width).toBe("25%");
    expect(bar.style.animation).toBe("");
  });

  it("hides the visual track from assistive technology", () => {
    render(<Progress value={10} label="Working" />);
    const track = screen.getByRole("progressbar").querySelector(".omnis-progress__track");
    expect(track?.getAttribute("aria-hidden")).toBe("true");
  });

  it("takes its colour from the theme", () => {
    render(<Progress value={10} tone="success" label="Working" data-testid="progress" />);
    const bar = screen.getByTestId("progress").querySelector(".omnis-progress__bar") as HTMLElement;
    expect(bar.style.background).toBe("var(--omnis-color-success)");
  });
});

describe("Badge", () => {
  it("is a span, because it labels rather than structures", () => {
    const { container } = render(<Badge>beta</Badge>);
    expect(container.firstElementChild?.tagName).toBe("SPAN");
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("does not claim to be a live region", () => {
    // role="status" on every badge would announce each one on render, which is noise
    // rather than information. A caller who needs that can add it.
    render(<Badge>queued</Badge>);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("derives tint, text and border from one theme colour", () => {
    render(
      <Badge tone="danger" data-testid="badge">
        failed
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(styleOf(badge, "color")).toBe("var(--omnis-color-danger)");
    const markup = styleMarkup(<Badge tone="danger">failed</Badge>);
    // One hue drives all three: a theme that adjusts `danger` for contrast fixes the
    // text, the tint and the border together.
    expect(markup).toContain(
      "background:color-mix(in srgb, var(--omnis-color-danger) 16%, transparent)",
    );
    expect(markup).toContain(
      "border-color:color-mix(in srgb, var(--omnis-color-danger) 34%, transparent)",
    );
    expect(badge.getAttribute("data-omnis-badge")).toBe("danger");
  });

  it("inverts to the on-primary colour when solid", () => {
    render(
      <Badge tone="primary" solid data-testid="badge">
        live
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(styleOf(badge, "background")).toBe("var(--omnis-color-primary)");
    expect(styleOf(badge, "color")).toBe("var(--omnis-color-text-on-primary)");
  });

  it("drops the fill when outlined", () => {
    render(
      <Badge tone="info" outline data-testid="badge">
        draft
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(styleOf(badge, "background")).toBe("transparent");
    expect(styleOf(badge, "border-color")).toBe("var(--omnis-color-info)");
  });

  it("prefers solid over outline when both are set", () => {
    // A filled badge is the stronger assertion; silently downgrading it would hide
    // what the caller asked for.
    render(
      <Badge tone="info" solid outline data-testid="badge">
        x
      </Badge>,
    );
    expect(styleOf(screen.getByTestId("badge"), "background")).toBe("var(--omnis-color-info)");
  });

  it("renders a decorative dot for colour-only states", () => {
    render(
      <Badge tone="success" dot data-testid="badge">
        online
      </Badge>,
    );
    const dot = screen.getByTestId("badge").querySelector(".omnis-badge__dot");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(styleOf(dot as HTMLElement, "background").toLowerCase()).toBe("currentcolor");
  });

  it("renders no dot when not asked for one", () => {
    render(
      <Badge tone="success" data-testid="badge">
        online
      </Badge>,
    );
    expect(screen.getByTestId("badge").querySelector(".omnis-badge__dot")).toBeNull();
  });

  it("can be rendered as a list item", () => {
    render(
      <ul>
        <Badge as="li" tone="neutral">
          item
        </Badge>
      </ul>,
    );
    expect(screen.getByText("item").tagName).toBe("LI");
  });
});
