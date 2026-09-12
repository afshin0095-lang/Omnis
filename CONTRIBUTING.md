# Contributing to OMNIS

OMNIS is built to be worked on by humans **and** by coding agents over a long horizon. That only works
if the architecture is explicit, the contracts are typed and the gates are green. This document is the
operational agreement.

## Before you start

1. Read [AGENTS.md](AGENTS.md) and
   [docs/05-implementation/AI_BUILD_GUIDE.md](docs/05-implementation/AI_BUILD_GUIDE.md).
2. Read [docs/01-architecture/ARCHITECTURE.md](docs/01-architecture/ARCHITECTURE.md) for the domains and
   [docs/01-architecture/PLATFORM_FOUNDATION.md](docs/01-architecture/PLATFORM_FOUNDATION.md) for the
   packages.
3. Find the specification for the code you are about to change. If it does not exist, write it first —
   do not infer an architecture from a local file.

## Environment

```bash
corepack enable          # pnpm 11 is the only package manager here
pnpm install
pnpm build               # required before running downstream tests
```

Node ≥ 22.12 (see [.nvmrc](.nvmrc)). Never add `npm` or `yarn` lockfiles, and never change the package
manager — see [ADR-0001](docs/07-decisions/ADR-0001-monorepo-and-toolchain.md).

## Working in vertical slices

```text
spec → contract → domain model → implementation → test → observability → docs → CI
```

A slice is complete only when every stage is done. A feature without tests, observability or a
documentation update is not finished, whatever the code looks like.

## Rules that are enforced, not suggested

| Rule                                                             | Enforced by                                         |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| No `any` unless unavoidable and justified in a comment           | `@typescript-eslint/no-explicit-any` + `tsc` strict |
| No unused exports, imports or variables                          | `noUnusedLocals`, `noUnusedParameters`, lint        |
| No workspace dependency cycles; dependencies point downward      | `pnpm verify:workspace`                             |
| Zod only inside `@omnis/validation`                              | `pnpm verify:workspace`                             |
| No committed secrets or credential-shaped strings                | `pnpm verify:secrets`                               |
| No placeholder files, empty files or `TODO` throws in core paths | review + `pnpm verify:workspace`                    |
| Identifiers are branded and parsed, never raw strings            | `@omnis/types` codec + tests                        |
| Events are registered and owned before they can be published     | `@omnis/events` registry + tests                    |
| Zero lint warnings                                               | `eslint --max-warnings=0`                           |

## Quality gates

Run these before opening a pull request; CI runs exactly the same set.

```bash
pnpm verify      # workspace health + secret scan
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check       # all of the above in one command
```

Do not weaken TypeScript strictness, disable a lint rule globally, or add `@ts-expect-error` to make a
gate pass. Fix the cause.

## Tests

- New domain behaviour requires unit tests.
- Cross-domain behaviour requires integration tests.
- Contracts require tests that pin the _rules_, not just the happy path: a payload schema test should
  assert why `null` is not `undefined`, and a bus test should assert what a failing handler may not do
  to its neighbours.
- Test files live next to the code they cover (`src/*.test.ts`).

## Documentation and decisions

- A change to a domain boundary, a package dependency rule, a contract version or the toolchain needs an
  ADR in [docs/07-decisions/](docs/07-decisions). Copy the structure of an existing ADR: context,
  decision, alternatives considered, consequences.
- Update [docs/SUMMARY.md](docs/SUMMARY.md) when you add a document, and
  [CHANGELOG.md](CHANGELOG.md) when you change behaviour.
- Keep references resolvable: `pnpm verify:workspace` fails on a link to a document that does not exist.

## Commit and pull request conventions

Conventional Commits, scoped by area:

```text
feat(events): add publishing.job.scheduled definition
fix(errors): redact bearer tokens in serialized metadata
docs(adr): record the frontend stack decision
test(telemetry): pin metric label cardinality rules
```

Keep a pull request to one vertical slice. Describe **why**, link the ADR or specification, and include
the gate output.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
