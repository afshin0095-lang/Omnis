# ADR-0001: Monorepo and Toolchain

- Status: Accepted
- Date: 2026-09-11
- Sprint: 0
- Supersedes: —
- Related: [ADR-0002](ADR-0002-domain-boundaries.md), [ADR-0004](ADR-0004-frontend-stack.md),
  [PLATFORM_FOUNDATION.md](../01-architecture/PLATFORM_FOUNDATION.md),
  [MONOREPO.md](../05-implementation/MONOREPO.md)

## Context

The Sprint 0 audit found a repository whose documentation described a 29-domain operating
system while the code consisted of a Vite starter app, two partially built UI packages and
40 specification documents. The concrete toolchain findings were worse than they looked:

- **Two TypeScript majors installed simultaneously** — 6.0.3 in some packages and 7.0.2 in
  others. `typescript-eslint@8.70.0` declares `typescript: >=4.8.4 <6.1.0` as its peer
  range, so type-aware linting could not run at all against 7.x.
- **Version skew across packages**, because every `package.json` pinned its own versions.
- **No shared compiler configuration**: strictness differed per package, so a type error
  could be real in one and invisible in another.
- **No test infrastructure in eight platform packages**, which meant `vitest run` exited 1
  on an empty glob and the "test" gate could not distinguish success from absence.
- **Bundler-driven library builds** (`tsup`) in a repository whose libraries are plain
  ESM TypeScript.

OMNIS will be worked on for years by humans and by multiple coding agents. Toolchain
ambiguity is not a style problem in that setting: it is the difference between an agent
that can verify its own work and one that guesses.

## Decision

1. **One repository, one package manager.** pnpm workspaces, `packageManager:
pnpm@11.13.0`, `engines.node >= 22.12`. npm and yarn lockfiles are rejected by the
   health checker.
2. **One version per shared dependency.** Every dependency used by two or more members is
   declared once in the `catalog` of `pnpm-workspace.yaml` and referenced as `catalog:`.
   Internal dependencies use `workspace:*`. `peerDependencies` are the sole exception,
   because a peer range is a published contract rather than an installation choice.
3. **TypeScript `~6.0.3` workspace-wide**, pinned to the 6.x line until
   `typescript-eslint` publishes support for 7.x.
4. **One strict compiler baseline.** `tsconfig.base.json` is a ratchet: options may be
   added or tightened, never relaxed to make a build pass. It enables `strict`,
   `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
   `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
   `useUnknownInCatchVariables`, `isolatedModules`, `verbatimModuleSyntax` and
   `erasableSyntaxOnly`.
5. **ESM only.** Libraries use `module`/`moduleResolution: NodeNext` with explicit `.js`
   extensions in relative imports; apps use `Bundler` resolution. No CommonJS output, no
   dual-package hazard.
6. **`tsc` builds libraries; no library bundler.** Each library has `tsconfig.json`
   (`noEmit: true`, includes tests) and `tsconfig.build.json` (`noEmit: false`, excludes
   tests).
7. **Turborepo orchestrates tasks**, with `build`, `typecheck`, `test` and `dev` all
   `dependsOn: ["^build"]`, so a package is always verified against the built output of
   its dependencies.
8. **Vitest 5 for all tests**, colocated as `src/*.test.ts(x)`, with happy-dom and Testing
   Library for DOM work.
9. **ESLint flat config with `--max-warnings=0`**, shared from the root. Syntax-only in
   Sprint 0; type-aware rules are tracked as Sprint 1 hardening in
   [DEVELOPMENT_WORKFLOW.md](../05-implementation/DEVELOPMENT_WORKFLOW.md).
10. **Structure is checked mechanically.** `scripts/check-workspace-health.mjs` enforces
    layering, cycles, technology ownership, version discipline, manifest shape, absence of
    empty/placeholder files and resolvability of documentation links;
    `scripts/scan-secrets.mjs` enforces the absence of credential-shaped material. Both run
    in `pnpm verify`, in `pnpm check` and in CI.

## Alternatives considered

**Polyrepo per domain.** Rejected: OMNIS domains share identifiers, errors and contracts.
Splitting them would turn every contract change into a cross-repository release dance, and
would make the dependency rules unenforceable rather than merely documented.

**npm or yarn workspaces.** Rejected: pnpm's strict node_modules layout catches undeclared
dependencies (a package importing something it does not declare fails to resolve), and its
catalog gives one place per version — the exact defect the audit found.

**Nx instead of Turborepo.** Rejected for Sprint 0: Nx brings generators, executors and a
plugin model OMNIS does not need yet, and a migration path off it is expensive. Turborepo
is a task runner over the existing pnpm scripts, so leaving it later costs one config file.

**`tsup`/`rollup`/`esbuild` for library builds.** Rejected: the libraries are plain ESM
TypeScript consumed inside the same workspace. A bundler adds a second source of truth for
declaration files, a peer-dependency constraint on TypeScript, and a build step whose
output must be debugged back to source. `tsc` already produces exactly what is needed.

**TypeScript 7.x.** Rejected while `typescript-eslint` supports `<6.1.0`: the newer
compiler would cost type-aware linting entirely, which is a worse trade than a compiler
minor.

**Bun or Deno as runtime.** Rejected: no deployment target requires them, and the
`@types/node` + Node 22 combination is what the ecosystem's tooling is tested against.

## Consequences

**Positive**

- One command (`pnpm check`) verifies the whole repository, and an agent can run it without
  understanding the task graph.
- Version skew is structurally impossible: a package cannot pin its own TypeScript.
- Strictness is uniform, so a type error means the same thing everywhere.
- The dependency rules are enforced by a gate rather than by review, which is the only form
  of enforcement that survives a year of contributions.

**Negative / accepted costs**

- Explicit `.js` extensions in TypeScript source are unfamiliar and occasionally surprising
  to new contributors; the payoff is that emitted code resolves under plain Node.
- `noUncheckedIndexedAccess` makes array and record access verbose. Accepted deliberately:
  it removes a real class of production failure.
- The TypeScript pin blocks compiler upgrades until `typescript-eslint` moves. Accepted, and
  monitored; the pin is documented in `pnpm-workspace.yaml` where a bump would be attempted.
- Turborepo's cache means a stale `dist` can confuse a contributor who edits a library and
  tests a dependent without rebuilding. Documented prominently in
  [MONOREPO.md](../05-implementation/MONOREPO.md).

## Compliance

Verified by `pnpm verify:workspace` and `pnpm check`. Changing any decision above requires
a superseding ADR; changing the strictness baseline downwards is prohibited by
[AGENTS.md](../../AGENTS.md) and by review.
