/**
 * Test setup.
 *
 * `cleanup` is registered explicitly because the suite does not enable Vitest
 * globals: React Testing Library can only auto-register its cleanup when a global
 * `afterEach` exists. Without this, every test would render into the previous
 * test's tree and `getByRole` would find duplicate elements.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { removeBaseStyles } from "./src/styles/index.js";

afterEach(() => {
  cleanup();
  // The provider injects the library stylesheet into the document; removing it
  // keeps assertions about injection meaningful in the next test.
  removeBaseStyles();
});
