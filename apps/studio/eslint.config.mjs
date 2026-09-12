// Studio ESLint configuration.
//
// Layers React-specific rules on top of the shared OMNIS rule set instead of
// restating it, so the frontend cannot drift from the platform's code-quality
// baseline. The Sprint 0 audit found exactly that kind of drift in dependency
// versions; the same failure mode applies to lint rules.
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { omnisIgnores, omnisRules } from "../../eslint.config.mjs";

/**
 * The application directory.
 *
 * The shared config is imported from the repository root, so typescript-eslint sees
 * two candidate roots and will not choose between them. This pins the parser to the
 * app, whose tsconfig projects cover every file linted here.
 */
const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default tseslint.config(
  { ignores: [...omnisIgnores, "dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.es2023, ...globals.browser },
      parserOptions: {
        tsconfigRootDir,
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...omnisRules,
      // Tests render components and assert on DOM state; the DOM globals differ
      // from the Node globals the shared config assumes.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "vitest.setup.ts", "**/*.config.{ts,mjs}"],
    languageOptions: {
      globals: { ...globals.es2023, ...globals.browser, ...globals.node },
    },
    rules: {
      // A test that asserts on observable output must be allowed to touch it.
      "no-console": "off",
    },
  },
);
