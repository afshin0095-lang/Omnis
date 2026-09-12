/**
 * Utility tests.
 *
 * The most important assertion here is the last one: that every custom property the
 * UI layer references is actually published by the theme. The two packages declare
 * their contract in different places, and without this test a rename in
 * `@omnis/theme` would silently strip styling from every component.
 */

import { themeToCssVariables } from "@omnis/theme";
import { DARK_THEME, THEMES } from "@omnis/theme";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  blockClass,
  cn,
  componentClass,
  composeRefs,
  CSS_VARS,
  cssVarNames,
  elementClass,
  ELEVATION_VAR,
  RADIUS_SCALES,
  RADIUS_VAR,
  SPACE_VAR,
  SPACING_STEPS,
} from "./index.js";

describe("class name composition", () => {
  it("joins truthy values and drops falsy ones", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
    expect(cn({ a: true, b: false })).toBe("a");
    expect(cn()).toBe("");
  });

  it("builds prefixed BEM names", () => {
    expect(blockClass("button")).toBe("omnis-button");
    expect(blockClass("button", "primary")).toBe("omnis-button--primary");
    expect(elementClass("button", "label")).toBe("omnis-button__label");
  });

  it("puts the caller's classes last so they can win a specificity tie", () => {
    const result = componentClass("button", {
      variant: "primary",
      size: "lg",
      active: true,
      disabled: false,
      className: "consumer-class",
    });
    expect(result).toBe(
      "omnis-button omnis-button--primary omnis-button--lg omnis-button--active consumer-class",
    );
    expect(result.endsWith("consumer-class")).toBe(true);
  });

  it("omits modifiers that were not requested", () => {
    expect(componentClass("card")).toBe("omnis-card");
    expect(componentClass("card", { variant: undefined, size: undefined })).toBe("omnis-card");
  });
});

describe("composeRefs", () => {
  it("assigns an object ref and a callback ref together", () => {
    const objectRef = createRef<HTMLDivElement>();
    const callback = vi.fn();
    const element = document.createElement("div");

    composeRefs(objectRef, callback)(element);

    expect(objectRef.current).toBe(element);
    expect(callback).toHaveBeenCalledWith(element);
  });

  it("clears every ref when detached with null", () => {
    const objectRef = createRef<HTMLDivElement>();
    const callback = vi.fn();

    composeRefs(objectRef, callback)(null);

    expect(objectRef.current).toBeNull();
    expect(callback).toHaveBeenCalledWith(null);
  });

  it("tolerates null and undefined entries", () => {
    const objectRef = createRef<HTMLDivElement>();
    const element = document.createElement("div");
    expect(() => composeRefs(null, undefined, objectRef)(element)).not.toThrow();
    expect(objectRef.current).toBe(element);
  });

  it("runs every inner cleanup, in reverse order", () => {
    // React 19 ref callbacks may return a cleanup. Dropping them would keep a
    // detached element alive for whoever returned one.
    const order: string[] = [];
    const first = vi.fn((_value: HTMLDivElement | null) => () => {
      order.push("first");
    });
    const second = vi.fn((_value: HTMLDivElement | null) => () => {
      order.push("second");
    });
    const element = document.createElement("div");

    const detach = composeRefs(first, second)(element);

    expect(first).toHaveBeenCalledWith(element);
    expect(second).toHaveBeenCalledWith(element);
    expect(typeof detach).toBe("function");
    detach?.();
    expect(order).toEqual(["second", "first"]);
  });

  it("returns undefined when no ref produced a cleanup", () => {
    const objectRef = createRef<HTMLDivElement>();
    expect(composeRefs(objectRef)(document.createElement("div"))).toBeUndefined();
  });
});

describe("scale maps cover the theme", () => {
  it("maps every spacing step the theme defines", () => {
    // The steps are numbers and `Object.keys` yields strings, so both sides are
    // compared as strings — the same form a component receives from a token lookup.
    const steps = SPACING_STEPS.map(String).sort();
    expect(steps).toEqual(Object.keys(DARK_THEME.spacing).sort());
    // The exported step list and the map must not drift apart: a step listed but not
    // mapped would render `undefined` into a style attribute.
    expect(Object.keys(SPACE_VAR).sort()).toEqual(steps);
    for (const step of SPACING_STEPS) {
      expect(SPACE_VAR[step], String(step)).toMatch(/^var\(--omnis-space-/);
    }
  });

  it("maps every radius step the theme defines", () => {
    const scales = RADIUS_SCALES.slice().sort();
    expect(scales).toEqual(Object.keys(DARK_THEME.radius).sort());
    expect(Object.keys(RADIUS_VAR).sort()).toEqual(scales);
    for (const step of RADIUS_SCALES) {
      expect(RADIUS_VAR[step], step).toMatch(/^var\(--omnis-radius-/);
    }
  });

  it("maps every elevation onto a shadow the theme publishes", () => {
    for (const value of Object.values(ELEVATION_VAR)) {
      expect(value).toMatch(/^var\(--omnis-shadow-/);
    }
  });
});

describe("CSS_VARS stays in sync with the theme", () => {
  const names = cssVarNames();

  it("references only well-formed custom properties", () => {
    expect(names.length).toBeGreaterThan(60);
    for (const name of names) {
      expect(name.startsWith("--omnis-"), name).toBe(true);
      expect(name, name).not.toContain("var(");
    }
  });

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "every referenced property is published by %s",
    (_id, theme) => {
      // This is the drift check: a token renamed in @omnis/theme and not here would
      // render as an unresolvable var() and strip styling from every component.
      const published = new Set(Object.keys(themeToCssVariables(theme)));
      const missing = names.filter((name) => !published.has(name));
      expect(missing).toEqual([]);
    },
  );

  it("has no duplicate property names", () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it("enumerates the CSS_VARS map rather than a hand-maintained copy", () => {
    // If the helper kept its own list, adding a token to the map would leave it out
    // of every drift check above — the checks would pass and the new token would be
    // unverified. Deriving one from the other makes that impossible.
    expect(names).toEqual(Object.values(CSS_VARS).map((value) => value.slice("var(".length, -1)));
  });
});
