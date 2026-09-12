import { defineConfig } from "vitest/config";

/**
 * Component tests run in a DOM.
 *
 * `happy-dom` rather than `jsdom`: it implements enough of the platform for focus
 * management, `matchMedia`, portals and CSS custom properties — which is what these
 * tests exercise — while starting an order of magnitude faster. A suite that takes
 * seconds gets run before every commit; one that takes minutes gets skipped.
 */
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
  },
});
