import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Studio build configuration.
 *
 * `vite-tsconfig-paths` was removed: this project declares no `paths`, so the plugin
 * was doing nothing except adding a dependency and a deprecation warning. Vite 8
 * resolves tsconfig paths natively through `resolve.tsconfigPaths` if the Studio ever
 * needs aliases.
 *
 * The dev server binds to every interface. The Studio is developed inside a
 * sandboxed preview and is proxied under a public host, so binding to loopback would
 * make it unreachable, and an `allowedHosts` list would reject the proxy origin.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    // The preview host is dynamic, so origin checks are disabled rather than
    // maintained as a list that goes stale.
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // The Studio imports @omnis/ui and @omnis/theme as workspace packages; they are
    // already built to ESM, so no extra transpilation is needed.
    target: "es2023",
  },
});
