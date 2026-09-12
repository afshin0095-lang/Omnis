/**
 * Control tests: Button, IconButton, Input.
 *
 * These are the components where an accessibility mistake has a real cost — a
 * button that submits a form it does not belong to, an icon control with no name, a
 * field whose error is only ever expressed as a colour. The assertions are about
 * those failures, not about appearance.
 *
 * The suite deliberately does not depend on `@testing-library/jest-dom`: plain DOM
 * reads say exactly what is being checked and keep the dependency list short.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { refCapture } from "../testing/refCapture.js";
import { Button } from "./Button/Button.js";
import { IconButton } from "./IconButton/IconButton.js";
import { Input } from "./Input/Input.js";

/** Attribute list of an element, for readable assertions about class names. */
function classes(element: Element): string[] {
  return element.className.split(/\s+/).filter((name) => name.length > 0);
}

describe("Button", () => {
  it("renders a real button element with an accessible name", () => {
    render(<Button>Run pipeline</Button>);
    const button = screen.getByRole("button", { name: "Run pipeline" });
    expect(button.tagName).toBe("BUTTON");
  });

  it("defaults to type=button so it cannot submit an enclosing form", () => {
    // React's own default is "submit"; a button dropped into any form would
    // otherwise submit it — invisible in isolation, destructive in use.
    render(
      <form>
        <Button>Save</Button>
      </form>,
    );
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("type")).toBe("button");
  });

  it("honours an explicit submit type", () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("type")).toBe("submit");
  });

  it("calls onClick with the event", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("marks the variant and size on the element", () => {
    render(
      <Button variant="danger" size="lg" glow>
        Delete
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.getAttribute("data-omnis-button")).toBe("danger");
    expect(button.getAttribute("data-loading")).toBeNull();
    expect(classes(button)).toEqual(
      expect.arrayContaining(["omnis-button", "omnis-button--danger", "omnis-button--lg"]),
    );
  });

  it("keeps the caller's class alongside its own, last", () => {
    render(<Button className="consumer">Go</Button>);
    const names = classes(screen.getByRole("button", { name: "Go" }));
    expect(names).toContain("omnis-button");
    expect(names).toContain("consumer");
    // Last, so a consumer stylesheet of equal specificity wins without !important.
    expect(names[names.length - 1]).toBe("consumer");
  });

  it("does not fire while loading, and says it is busy", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Publish
      </Button>,
    );

    const button = screen.getByRole("button", { name: /Publish/ }) as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("data-loading")).toBe("true");

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("replaces the leading icon with a spinner while loading so the width is stable", () => {
    const { rerender } = render(<Button iconLeft={<span data-testid="icon">i</span>}>Go</Button>);
    expect(screen.getByTestId("icon")).toBeTruthy();

    rerender(
      <Button loading iconLeft={<span data-testid="icon">i</span>}>
        Go
      </Button>,
    );
    expect(screen.queryByTestId("icon")).toBeNull();
    // The spinner is a status region, so the state is announced, not just shown.
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("announces a custom loading label", () => {
    render(
      <Button loading loadingLabel="Rendering clip 3 of 8">
        Render
      </Button>,
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Rendering clip 3 of 8");
  });

  it("renders the trailing icon as well as the leading one", () => {
    render(
      <Button iconLeft={<span data-testid="left" />} iconRight={<span data-testid="right" />}>
        Go
      </Button>,
    );
    expect(screen.getByTestId("left")).toBeTruthy();
    expect(screen.getByTestId("right")).toBeTruthy();
  });

  it("can be disabled outright", () => {
    render(<Button disabled>Locked</Button>);
    expect((screen.getByRole("button", { name: "Locked" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("forwards a ref to the underlying element", () => {
    const captured = refCapture<HTMLButtonElement>();
    render(<Button ref={captured.ref}>Go</Button>);
    expect(captured.read()).not.toBeNull();
    expect(captured.read()?.tagName).toBe("BUTTON");
  });

  it("renders as another element when asked, without button-only attributes", () => {
    render(
      <Button as="a" href="/studio">
        Open Studio
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Open Studio" });
    expect(link.tagName).toBe("A");
    // `type` and `disabled` are meaningless on an anchor and would be invalid HTML.
    expect(link.getAttribute("type")).toBeNull();
    expect(link.getAttribute("disabled")).toBeNull();
    expect(link.getAttribute("href")).toBe("/studio");
  });

  it("spans the container when fullWidth is set", () => {
    render(<Button fullWidth>Go</Button>);
    expect(classes(screen.getByRole("button", { name: "Go" }))).toContain(
      "omnis-button--full-width",
    );
  });
});

describe("IconButton", () => {
  const icon = <svg data-testid="icon" aria-hidden="true" />;

  it("names itself from the required label prop", () => {
    render(<IconButton icon={icon} label="Close panel" onClick={() => {}} />);
    const button = screen.getByRole("button", { name: "Close panel" });
    expect(button.getAttribute("aria-label")).toBe("Close panel");
  });

  it("does not add a native title, so it cannot fight with a Tooltip", () => {
    // A `title` would duplicate the accessible name and, inside a <Tooltip>, offer
    // two competing hints on the same control.
    render(<IconButton icon={icon} label="Close panel" />);
    expect(screen.getByRole("button", { name: "Close panel" }).getAttribute("title")).toBeNull();
  });

  it("passes a caller-supplied title through unchanged", () => {
    render(<IconButton icon={icon} label="Close panel" title="Dismiss" />);
    const button = screen.getByRole("button", { name: "Close panel" });
    expect(button.getAttribute("title")).toBe("Dismiss");
    expect(button.getAttribute("aria-label")).toBe("Close panel");
  });

  it("hides the icon from assistive technology", () => {
    render(<IconButton icon={icon} label="Close panel" />);
    // The label already carries the meaning; announcing the graphic too would read
    // as "Close panel graphic".
    expect(screen.getByTestId("icon").parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is square and sized from the shared control scale", () => {
    render(<IconButton icon={icon} label="Close panel" size="lg" />);
    const button = screen.getByRole("button", { name: "Close panel" }) as HTMLElement;
    expect(button.style.width).toBe("var(--omnis-component-button-height-lg)");
    // Zero inline padding is what makes the control square rather than icon-shaped.
    expect(button.style.paddingInline).toBe("0");
  });

  it("forwards clicks to the caller", () => {
    const onClick = vi.fn();
    render(<IconButton icon={icon} label="Run" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards the loading state to Button", () => {
    render(<IconButton icon={icon} label="Busy" loading />);
    const button = screen.getByRole("button", { name: "Busy" });
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});

describe("Input", () => {
  it("associates a real label with the field", () => {
    render(<Input label="Character name" />);
    const field = screen.getByLabelText("Character name");
    expect(field.tagName).toBe("INPUT");
    // Association is by id rather than nesting alone, so it survives being moved.
    expect(document.querySelector(`label[for="${field.id}"]`)).not.toBeNull();
  });

  it("marks a required field without announcing the visual asterisk", () => {
    render(<Input label="Email" required />);
    const field = screen.getByLabelText(/Email/) as HTMLInputElement;
    expect(field.required).toBe(true);
    expect(screen.getByText("*").getAttribute("aria-hidden")).toBe("true");
  });

  it("links hint text with aria-describedby", () => {
    render(<Input label="Handle" hint="Lowercase, no spaces" />);
    const field = screen.getByLabelText("Handle");
    const describedBy = field.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toContain(`${field.id}-hint`);
    expect(document.getElementById(`${field.id}-hint`)?.textContent).toBe("Lowercase, no spaces");
  });

  it("marks an error as invalid and describes the field with it", () => {
    render(<Input label="Handle" error="That handle is taken" hint="Lowercase, no spaces" />);
    const field = screen.getByLabelText("Handle");

    expect(field.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (field.getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toContain(`${field.id}-hint`);
    expect(describedBy).toContain(`${field.id}-error`);
    expect(document.getElementById(`${field.id}-error`)?.textContent).toBe("That handle is taken");
  });

  it("does not point aria-describedby at elements it did not render", () => {
    // A dangling reference is read as silence and hides a real wiring bug.
    render(<Input label="Bare" />);
    const field = screen.getByLabelText("Bare");
    expect(field.getAttribute("aria-describedby")).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("can be marked invalid without an error message", () => {
    render(<Input label="Token" invalid />);
    expect(screen.getByLabelText("Token").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps a stable id across renders and accepts an explicit one", () => {
    const view = render(<Input label="Stable" />);
    const first = screen.getByLabelText("Stable").id;
    view.rerender(<Input label="Stable" hint="now with a hint" />);
    expect(screen.getByLabelText(/Stable/).id).toBe(first);

    view.unmount();
    render(<Input id="explicit-id" label="Explicit" />);
    expect(screen.getByLabelText("Explicit").id).toBe("explicit-id");
    expect(document.querySelector("label[for='explicit-id']")).not.toBeNull();
  });

  it("decorates the affix slots without exposing them to assistive technology", () => {
    render(
      <Input
        label="Search"
        prefix={<span data-testid="prefix">q</span>}
        suffix={<span data-testid="suffix">/</span>}
      />,
    );
    // The affix wrapper carries aria-hidden, so decoration is never announced.
    expect(screen.getByTestId("prefix").parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("suffix").parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("prefix").parentElement?.className).toBe("omnis-field__prefix");
    expect(screen.getByLabelText("Search")).toBeTruthy();
  });

  it("forwards a ref and native props to the input element", () => {
    const captured = refCapture<HTMLInputElement>();
    render(<Input label="Bio" placeholder="Tell the story" maxLength={280} ref={captured.ref} />);
    const input = captured.read();
    expect(input?.tagName).toBe("INPUT");
    expect(input?.placeholder).toBe("Tell the story");
    expect(input?.maxLength).toBe(280);
  });

  it("propagates typing to the caller", () => {
    function Harness(): ReactNode {
      const [value, setValue] = useState("");
      return (
        <>
          <Input label="Name" value={value} onChange={(event) => setValue(event.target.value)} />
          <output data-testid="echo">{value}</output>
        </>
      );
    }

    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Aria" } });
    expect(screen.getByTestId("echo").textContent).toBe("Aria");
  });

  it("renders a disabled field that is still labelled", () => {
    render(<Input label="Locked" disabled value="immutable" onChange={() => {}} />);
    const field = screen.getByLabelText("Locked") as HTMLInputElement;
    expect(field.disabled).toBe(true);
    expect(field.value).toBe("immutable");
  });
});
