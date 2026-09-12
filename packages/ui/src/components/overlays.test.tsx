/**
 * Overlay tests: Modal and Tooltip.
 *
 * Overlays are where a component library either does accessibility properly or
 * doesn't. A dialog that does not move focus, does not trap it, does not restore it
 * and cannot be dismissed with Escape is not a dialog — it is a div on top of the
 * page, and a keyboard or screen reader user cannot tell it is there.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button/Button.js";
import { Modal } from "./Modal/Modal.js";
import { Tooltip } from "./Tooltip/Tooltip.js";

/** A trigger button plus a modal, so focus can be observed moving between them. */
function ModalHarness(props: {
  onClose?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
  closeOnEscape?: boolean;
  closeOnOverlayClick?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  title?: ReactNode;
  description?: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const onClose = (): void => {
    setOpen(false);
    props.onClose?.();
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <Modal
        open={open}
        onClose={onClose}
        title={props.title ?? "Delete character"}
        description={props.description}
        dismissible={props.dismissible}
        closeOnEscape={props.closeOnEscape}
        closeOnOverlayClick={props.closeOnOverlayClick}
        initialFocusRef={props.initialFocusRef}
        footer={props.footer}
      >
        {props.children ?? <p>This cannot be undone.</p>}
      </Modal>
    </>
  );
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-omnis-modal-overlay]");
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function openModal(): void {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "open" }));
  });
}

afterEach(() => {
  // A leaked scroll lock or inert attribute would poison every later test.
  document.body.style.overflow = "";
  document.body.style.paddingRight = "";
  for (const element of Array.from(document.body.children)) {
    element.removeAttribute("inert");
  }
});

describe("Modal", () => {
  it("renders nothing while closed", () => {
    render(<ModalHarness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(overlay()).toBeNull();
  });

  it("is a modal dialog with an accessible name and description", () => {
    render(<ModalHarness description="Aria has 12 published clips." />);
    openModal();

    const element = dialog();
    expect(element.getAttribute("aria-modal")).toBe("true");
    expect(element.getAttribute("aria-labelledby")).toBeTruthy();
    expect(element.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Delete character" })).toBeTruthy();
    expect(screen.getByText("Aria has 12 published clips.")).toBeTruthy();
  });

  it("omits aria-describedby when there is no description", () => {
    render(<ModalHarness />);
    openModal();
    expect(dialog().getAttribute("aria-describedby")).toBeNull();
  });

  it("is portalled to the end of the document body", () => {
    // A dialog nested inside an overflow:hidden or transformed ancestor is clipped
    // by it, and a transformed ancestor becomes the containing block for
    // position:fixed, which silently breaks the overlay's coverage.
    render(
      <div data-testid="clipper" style={{ overflow: "hidden", transform: "translateX(10px)" }}>
        <ModalHarness />
      </div>,
    );
    openModal();

    expect(overlay()?.parentElement).toBe(document.body);
    expect(dialog().closest("[data-testid='clipper']")).toBeNull();
  });

  it("moves focus into the dialog when it opens", () => {
    render(<ModalHarness />);
    screen.getByRole("button", { name: "open" }).focus();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "open" }));

    openModal();

    // Focus must not stay on the trigger behind an aria-modal dialog: a keyboard
    // user would tab into content they have been told is hidden.
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
  });

  it("honours an explicit initial focus target", () => {
    const confirmRef = createRef<HTMLButtonElement>();
    render(
      <ModalHarness initialFocusRef={confirmRef}>
        <button type="button" ref={confirmRef}>
          Confirm
        </button>
      </ModalHarness>,
    );
    openModal();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm" }));
  });

  it("returns focus to the trigger when it closes", () => {
    render(<ModalHarness />);
    const trigger = screen.getByRole("button", { name: "open" });
    trigger.focus();
    openModal();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    openModal();

    act(() => {
      fireEvent.keyDown(dialog(), { key: "Escape" });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can be told not to close on Escape", () => {
    // A form mid-edit is the case where losing work to a stray keypress is worse
    // than requiring an explicit dismissal.
    render(<ModalHarness closeOnEscape={false} />);
    openModal();

    act(() => {
      fireEvent.keyDown(dialog(), { key: "Escape" });
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes on an overlay click but not on a drag that ends on the overlay", () => {
    render(<ModalHarness />);
    openModal();

    // A selection drag that starts on the content and is released over the overlay
    // must not be read as a request to close.
    fireEvent.pointerDown(dialog(), { bubbles: true });
    act(() => {
      fireEvent.click(overlay() as HTMLElement);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => {
      fireEvent.click(overlay() as HTMLElement);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can be told not to close on an overlay click", () => {
    render(<ModalHarness closeOnOverlayClick={false} />);
    openModal();
    act(() => {
      fireEvent.click(overlay() as HTMLElement);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not close when the click lands inside the dialog", () => {
    render(<ModalHarness />);
    openModal();
    act(() => {
      fireEvent.click(dialog());
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("traps forward tabbing at the last focusable element", () => {
    render(
      <ModalHarness>
        <button type="button">last</button>
      </ModalHarness>,
    );
    openModal();

    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    expect(document.activeElement).toBe(last);

    act(() => {
      fireEvent.keyDown(dialog(), { key: "Tab" });
    });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
  });

  it("traps backward tabbing at the first focusable element", () => {
    render(
      <ModalHarness>
        <button type="button">last</button>
      </ModalHarness>,
    );
    openModal();

    const first = screen.getByRole("button", { name: "Close dialog" });
    first.focus();

    act(() => {
      fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "last" }));
  });

  it("keeps focus on the dialog when there is nothing to tab to", () => {
    render(<ModalHarness dismissible={false} />);
    openModal();

    const element = dialog();
    element.focus();
    act(() => {
      fireEvent.keyDown(element, { key: "Tab" });
    });

    expect(document.activeElement).toBe(element);
  });

  it("locks background scrolling and unlocks it on close", () => {
    render(<ModalHarness />);
    expect(document.body.style.overflow).toBe("");

    openModal();
    expect(document.body.style.overflow).toBe("hidden");

    act(() => {
      fireEvent.keyDown(dialog(), { key: "Escape" });
    });
    expect(document.body.style.overflow).toBe("");
  });

  it("makes the rest of the page inert, and only while open", () => {
    render(
      <div data-testid="page">
        <div data-testid="sibling">background</div>
        <ModalHarness />
      </div>,
    );

    // The rendered page is a direct child of <body>, which is what the dialog's
    // inert sweep operates on.
    const page = screen.getByTestId("page").parentElement as HTMLElement;
    expect(page.contains(screen.getByTestId("sibling"))).toBe(true);

    expect(page.hasAttribute("inert")).toBe(false);
    openModal();
    // `aria-modal` describes the dialog to a screen reader; `inert` is what actually
    // stops keyboard and pointer access to the content behind it.
    expect(page.hasAttribute("inert")).toBe(true);

    act(() => {
      fireEvent.keyDown(dialog(), { key: "Escape" });
    });
    expect(page.hasAttribute("inert")).toBe(false);
  });

  it("renders the footer only when one is supplied", () => {
    const withoutFooter = render(<ModalHarness />);
    openModal();
    expect(document.querySelector(".omnis-modal__footer")).toBeNull();
    withoutFooter.unmount();

    render(
      <ModalHarness
        footer={
          <>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Delete</Button>
          </>
        }
      />,
    );
    openModal();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("can be rendered without a dismissal affordance", () => {
    render(<ModalHarness dismissible={false} title="Working" />);
    openModal();
    expect(screen.queryByRole("button", { name: "Close dialog" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Working" })).toBeTruthy();
  });

  it("sizes from a fixed scale that never exceeds the viewport", () => {
    for (const size of ["sm", "md", "lg", "full"] as const) {
      const view = render(
        <Modal open onClose={() => {}} title={size} size={size}>
          body
        </Modal>,
      );
      const element = dialog();
      expect(element.style.maxWidth, size).toBe(
        { sm: "26rem", md: "36rem", lg: "52rem", full: "80rem" }[size],
      );
      // Fluid within the overlay's inset, capped by the size.
      expect(element.style.width, size).toBe("100%");
      expect(element.className).toContain(`omnis-modal--${size}`);
      view.unmount();
    }
  });
});

describe("Tooltip", () => {
  const trigger = <button type="button">Publish</button>;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is hidden until asked for", () => {
    render(<Tooltip content="Sends the clip to every connected platform">{trigger}</Tooltip>);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("appears immediately on keyboard focus", () => {
    render(<Tooltip content="Sends the clip">{trigger}</Tooltip>);
    act(() => {
      fireEvent.focus(screen.getByRole("button", { name: "Publish" }));
    });
    // A tooltip that only appears on hover is invisible to anyone who does not use
    // a pointer, which makes its content pointer-only.
    expect(screen.getByRole("tooltip").textContent).toBe("Sends the clip");
  });

  it("waits out the hover delay before appearing", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Sends the clip" delay={250}>
        {trigger}
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Publish" });

    fireEvent.mouseEnter(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("cancels a pending hover when the pointer leaves early", () => {
    vi.useFakeTimers();
    render(<Tooltip content="Sends the clip">{trigger}</Tooltip>);
    const button = screen.getByRole("button", { name: "Publish" });

    fireEvent.mouseEnter(button);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.mouseLeave(button);
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hides on blur and on mouse leave", () => {
    render(<Tooltip content="Sends the clip">{trigger}</Tooltip>);
    const button = screen.getByRole("button", { name: "Publish" });

    act(() => {
      fireEvent.focus(button);
    });
    expect(screen.getByRole("tooltip")).toBeTruthy();

    act(() => {
      fireEvent.blur(button);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      fireEvent.mouseEnter(button);
    });
    act(() => {
      fireEvent.mouseLeave(button);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("describes the trigger only while visible", () => {
    render(<Tooltip content="Sends the clip">{trigger}</Tooltip>);
    const button = screen.getByRole("button", { name: "Publish" });

    // A permanently-associated description is read on every focus even when nothing
    // is on screen, giving the user text with no visible counterpart.
    expect(button.getAttribute("aria-describedby")).toBeNull();

    act(() => {
      fireEvent.focus(button);
    });
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.getAttribute("role")).toBe("tooltip");
  });

  it("uses describedby rather than labelledby, so the trigger keeps its own name", () => {
    render(<Tooltip content="Sends the clip to every platform">{trigger}</Tooltip>);
    act(() => {
      fireEvent.focus(screen.getByRole("button", { name: "Publish" }));
    });
    // The accessible name is still the button's own text, not the tooltip.
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  });

  it("dismisses on Escape without closing a dialog underneath", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Tooltip content="Sends the clip">{trigger}</Tooltip>
      </div>,
    );
    const button = screen.getByRole("button", { name: "Publish" });

    act(() => {
      fireEvent.focus(button);
    });
    expect(screen.getByRole("tooltip")).toBeTruthy();

    act(() => {
      fireEvent.keyDown(button, { key: "Escape", bubbles: true });
    });

    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("preserves the trigger's own handlers", () => {
    const onMouseEnter = vi.fn();
    const onFocus = vi.fn();
    render(
      <Tooltip content="Sends the clip">
        <button type="button" onMouseEnter={onMouseEnter} onFocus={onFocus}>
          Publish
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Publish" });

    fireEvent.mouseEnter(button);
    act(() => {
      fireEvent.focus(button);
    });

    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("renders nothing extra when disabled", () => {
    render(
      <Tooltip content="Sends the clip" disabled>
        {trigger}
      </Tooltip>,
    );
    act(() => {
      fireEvent.focus(screen.getByRole("button", { name: "Publish" }));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("records its placement for styling hooks", () => {
    render(
      <Tooltip content="Sends the clip" placement="right">
        {trigger}
      </Tooltip>,
    );
    act(() => {
      fireEvent.focus(screen.getByRole("button", { name: "Publish" }));
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.getAttribute("data-omnis-tooltip")).toBe("right");
    expect(tooltip.className).toContain("omnis-tooltip--right");
    expect(tooltip.style.zIndex).toBe("var(--omnis-z-index-tooltip)");
  });

  it("accepts an explicit id for callers that need to reference it", () => {
    render(
      <Tooltip content="Sends the clip" id="publish-help">
        {trigger}
      </Tooltip>,
    );
    act(() => {
      fireEvent.focus(screen.getByRole("button", { name: "Publish" }));
    });
    expect(screen.getByRole("tooltip").id).toBe("publish-help");
    expect(screen.getByRole("button", { name: "Publish" }).getAttribute("aria-describedby")).toBe(
      "publish-help",
    );
  });

  it("does not let the tooltip itself be a pointer target", () => {
    render(<Tooltip content="Sends the clip">{trigger}</Tooltip>);
    act(() => {
      fireEvent.focus(screen.getByRole("button", { name: "Publish" }));
    });
    // `pointer-events: none` is what keeps the tooltip from stealing the hover that
    // is keeping it open, which would make it flicker.
    expect(screen.getByRole("tooltip").style.pointerEvents).toBe("none");
  });
});
