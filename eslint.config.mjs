// OMNIS shared ESLint flat configuration.
//
// Scope: every workspace member that does not ship its own config (packages/*,
// services/*, tests/, scripts/). apps/studio imports the exported `omnisRules`
// and `omnisIgnores` and layers React-specific configuration on top, so the rule
// set cannot drift between the frontend and the platform.
//
// The Sprint 0 audit found exactly this kind of drift (two TypeScript majors,
// two @types/node majors), so shared rule objects are exported rather than
// duplicated.
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * The directory the TypeScript parser resolves project configuration against.
 *
 * Stated explicitly rather than inferred: this module is imported by
 * `apps/studio/eslint.config.mjs`, which gives typescript-eslint two candidate roots
 * and it refuses to guess between them.
 */
const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

/** Paths that are never linted, in any workspace member. */
export const omnisIgnores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/*.tsbuildinfo",
  "pnpm-lock.yaml",
];

/**
 * The single source of truth for OMNIS code-quality rules.
 *
 * These encode the non-negotiables from AGENTS.md:
 *   - no accidental `any`
 *   - no unused imports, variables or parameters
 *   - no suppressed TypeScript diagnostics without a written justification
 *   - explicit `import type` for type-only imports (required by
 *     `verbatimModuleSyntax` and keeps emitted ESM free of phantom runtime deps)
 *
 * Deferred: type-aware rules (`no-floating-promises`, `no-misused-promises`,
 * `no-unnecessary-condition`) need `parserOptions.projectService`, which in turn
 * requires every linted file to belong to a tsconfig project. Sprint 0 keeps
 * lint syntax-only so the gate is robust; enabling type-aware linting is tracked
 * in docs/05-implementation/DEVELOPMENT_WORKFLOW.md as Sprint 1 hardening.
 */
export const omnisRules = {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      args: "all",
      argsIgnorePattern: "^_",
      vars: "all",
      varsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
  "@typescript-eslint/ban-ts-comment": [
    "error",
    {
      "ts-expect-error": "allow-with-description",
      minimumDescriptionLength: 12,
      "ts-ignore": true,
      "ts-nocheck": true,
      "ts-check": false,
    },
  ],
  "@typescript-eslint/consistent-type-imports": [
    "error",
    { prefer: "type-imports", fixStyle: "separate-type-imports" },
  ],
  "@typescript-eslint/no-import-type-side-effects": "error",
  "@typescript-eslint/no-unnecessary-type-constraint": "error",
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "error",
  "prefer-const": "error",
  "object-shorthand": ["error", "always"],
  "no-implicit-coercion": "error",
  "no-console": ["error", { allow: ["warn", "error"] }],
};

export default tseslint.config(
  { ignores: omnisIgnores },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.es2023, ...globals.node },
      parserOptions: { tsconfigRootDir },
    },
    rules: omnisRules,
  },
  {
    // Plain-JS tooling (eslint/prettier/vitest configs, scripts/*.mjs).
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.es2023, ...globals.node },
    },
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": ["error", "always"],
    },
  },
  {
    // The structured logger is the sanctioned console consumer, and tests need
    // to assert on observable output.
    files: ["packages/logging/src/**", "**/*.test.ts", "scripts/**"],
    rules: { "no-console": "off" },
  },
);
