# Monorepo Mechanics

Status: Accepted · Sprint 0

The practical guide to installing, building, testing and debugging this repository. The
architecture behind it is [PLATFORM_FOUNDATION.md](../01-architecture/PLATFORM_FOUNDATION.md);
the day-to-day loop is [DEVELOPMENT_WORKFLOW.md](DEVELOPMENT_WORKFLOW.md).

## 1. Prerequisites

| Tool | Version                             | Notes                                                        |
| ---- | ----------------------------------- | ------------------------------------------------------------ |
| Node | ≥ 22.12 (`.nvmrc` pins 22.22.3)     | Vitest 5 requires `^22.12.0 \|\| ^24 \|\| >=26`              |
| pnpm | 11 (`packageManager: pnpm@11.13.0`) | Enable with `corepack enable`. Never add npm or yarn         |
| git  | any recent                          | Required by `pnpm verify:secrets`, which scans tracked files |

## 2. First run

```bash
corepack enable
pnpm install          # add --frozen-lockfile in CI
pnpm build            # build every package in dependency order
pnpm test             # 815 tests
```

`pnpm install` creates the workspace links. Because `typecheck`, `test` and `dev` all
`dependsOn: ["^build"]` in [`turbo.json`](../../turbo.json), a package is always checked
against the **built output** of its dependencies.

> **The most common confusion in this repo:** change a library, run a downstream test,
> see the old behaviour. That is a stale `dist`, not a caching bug. Run `pnpm build`
> first, or `pnpm --filter <pkg>... build` to rebuild one package and its dependents.

## 3. Commands

### Root

| Command                             | What it does                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `pnpm build`                        | `turbo run build` — topological emit into each `dist/`                      |
| `pnpm typecheck`                    | `turbo run typecheck` — `tsc -p tsconfig.json`, no emit, includes tests     |
| `pnpm test`                         | `turbo run test` — Vitest per package                                       |
| `pnpm lint`                         | `turbo run lint` — ESLint, `--max-warnings=0`                               |
| `pnpm dev`                          | `turbo run dev` — Studio with HMR (persistent, uncached)                    |
| `pnpm format` / `pnpm format:check` | Prettier write / verify                                                     |
| `pnpm verify:workspace`             | `scripts/check-workspace-health.mjs` — structure, layering, docs, substance |
| `pnpm verify:secrets`               | `scripts/scan-secrets.mjs` — credential shapes in tracked files             |
| `pnpm verify`                       | both of the above                                                           |
| `pnpm check`                        | `verify` + `lint` + `typecheck` + `test` + `build` — the CI gate            |
| `pnpm clean`                        | `turbo run clean` — removes `dist` per package                              |

### Scoped

```bash
pnpm --filter @omnis/events run test          # one package
pnpm --filter @omnis/events... run build      # ...and everything it depends on
pnpm --filter "...@omnis/types" run test      # everything that depends on types
pnpm --filter studio run dev                  # the app
```

## 4. Adding a dependency

1. Decide whether it is shared. If two or more members need it, it goes in the `catalog`
   of [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) and is referenced as `catalog:`.
   The health checker fails on a directly pinned version.
2. Internal dependencies are always `workspace:*`.
3. `peerDependencies` are the one place a real range is correct — a peer range is a
   published contract, not an installation choice.
4. Run `pnpm install` (never `npm install`), then `pnpm check`.

Before adding anything, check whether an existing package already owns the concern:
validation belongs to `@omnis/validation`, errors to `@omnis/errors`, identifiers to
`@omnis/types`. A second validation library or a second error base class is an
architectural regression, not a convenience.

## 5. Package layout conventions

```text
packages/<name>/
├── package.json          private, type: module, main/types/exports → dist, 5 scripts
├── tsconfig.json         noEmit: true   — typecheck, includes tests
├── tsconfig.build.json   noEmit: false  — emit, excludes tests
├── vitest.config.ts      only when the package needs a non-default environment
└── src/
    ├── index.ts          the only public entry point
    ├── <module>.ts       implementation, one cohesive responsibility each
    └── <module>.test.ts  colocated tests
```

Library imports use explicit `.js` extensions (`./registry.js`) because NodeNext resolves
the emitted file, not the source. Apps (`studio`) use `Bundler` resolution and may omit
extensions.

## 6. Debugging recipes

**A package will not import.** Run its tests. A module-level throw — for example an
invalid event type parsed at load — makes the whole package unimportable, and the failure
surfaces in the _consumer_, not in the package that caused it. This happened in Sprint 0
with `audience.loyalty.tier_changed`; see
[EVENT_ARCHITECTURE.md](../01-architecture/EVENT_ARCHITECTURE.md).

**Types disagree between packages.** `pnpm --filter <lib>... run build` then re-run. If it
persists, delete `dist` (`pnpm --filter <lib> run clean`) and rebuild.

**A test passes alone but fails in the suite.** Look for shared module state. Tests must
not depend on execution order; where a module-level singleton is involved (the shared
`NOOP_TRACER`, for example), assert on a freshly created instance instead.

**Lint fails on a file the editor shows clean.** The gate is `--max-warnings=0`, so a
warning is a failure. Run `pnpm --filter <pkg> run lint` to see it.

**The health gate fails.** Read the output: every finding names a file and a rule. The
rules are documented in the header of
[`scripts/check-workspace-health.mjs`](../../scripts/check-workspace-health.mjs).

## 7. Known constraints

- **TypeScript is pinned to the 6.x line** (`~6.0.3`) because `typescript-eslint` 8.x
  declares `typescript: >=4.8.4 <6.1.0` as its peer range. Do not bump to 7.x until
  typescript-eslint publishes support. See
  [ADR-0001](../07-decisions/ADR-0001-monorepo-and-toolchain.md).
- **ESLint is syntax-only in Sprint 0.** Type-aware rules need
  `parserOptions.projectService`, which requires every linted file to belong to a tsconfig
  project. Enabling them is tracked in
  [DEVELOPMENT_WORKFLOW.md](DEVELOPMENT_WORKFLOW.md).
- **happy-dom is not a browser.** It does not implement `backdrop-filter`,
  `-webkit-line-clamp`, `color-mix()` inside shorthand, `min()` in `width`, and its
  `dataset` proxy ignores `removeAttribute`. UI tests that need a literal style attribute
  use `renderToStaticMarkup` and assert longhand properties.
- **`framer-motion`, not `motion`.** The workspace installs `framer-motion@12`; adding the
  `motion` package would put two copies of the same engine in the graph. Imports read
  `from "framer-motion"`. See
  [ADR-0004](../07-decisions/ADR-0004-frontend-stack.md).
