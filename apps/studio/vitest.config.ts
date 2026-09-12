import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Studio tests.
 *
 * These are integration tests rather than unit tests: they render the real page with
 * the real theme provider and the real component library, and assert on what a
 * visitor and an assistive technology would actually receive. Unit coverage of the
 * primitives lives in `packages/ui`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
  },
});
