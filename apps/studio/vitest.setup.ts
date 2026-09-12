import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { removeBaseStyles } from "@omnis/ui";

afterEach(() => {
  cleanup();
  removeBaseStyles();
  // The Studio applies its theme to the document element at bootstrap; clearing it
  // keeps one test's theme from leaking into the next.
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-omnis-theme");
  document.body.removeAttribute("style");
});
