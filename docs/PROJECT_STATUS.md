# Project Status

Authoritative snapshot of what exists **right now**. Updated at the end of every Sprint.
This document is deliberately blunt about what is _not_ built: a status page that implies
capability the repository does not have is worse than no status page.

Last updated: Sprint 0 complete · 2026-09-11

## 1. Summary

| Area                                                                             | State                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Repository foundation (monorepo, toolchain, gates)                               | **Complete**                                                           |
| Platform packages (11)                                                           | **Complete**, 815 tests green                                          |
| Documentation set (architecture, contracts, ADRs, specs)                         | **Complete** for Sprint 0 scope                                        |
| Studio operator surface                                                          | **Foundation complete** — branding, layout, welcome page; no features  |
| CI                                                                               | GitHub Actions workflow running the full gate on push and pull request |
| Domain implementations (Character OS, Content Factory, Publishing, Analytics, …) | **Not started** — specifications only                                  |
| AI Core (agents, models, providers, tools, policy, budget)                       | **Not started** — Sprint 1                                             |
| Durable event transport, database, queues                                        | **Not started** — the in-memory bus is a reference implementation      |
| Provider integrations (OpenAI, Anthropic, Google, platforms)                     | **None** — deliberate; no vendor SDK is installed anywhere             |
| Deployment                                                                       | **Not started**                                                        |

## 2. Quality gates

| Gate             | Command                          | Result                                     |
| ---------------- | -------------------------------- | ------------------------------------------ |
| Install          | `pnpm install --frozen-lockfile` | pass                                       |
| Build            | `pnpm build`                     | 11/11 packages                             |
| Typecheck        | `pnpm typecheck`                 | 17/17 tasks, strict, includes tests        |
| Lint             | `pnpm lint`                      | 11/11 packages, `--max-warnings=0`         |
| Test             | `pnpm test`                      | **815 tests**, 11/11 packages              |
| Workspace health | `pnpm verify:workspace`          | pass — 0 findings                          |
| Secret scan      | `pnpm verify:secrets`            | pass — 267 files, 16 audited test fixtures |
| Combined         | `pnpm check`                     | pass                                       |

## 3. Packages

| Package             | Source LOC | Tests   | Role                                                        |
| ------------------- | ---------- | ------- | ----------------------------------------------------------- |
| `@omnis/types`      | 1 895      | 92      | Branded identifiers, value types, vocabularies, JSON guards |
| `@omnis/errors`     | 1 341      | 79      | 13-class error hierarchy, stable codes, redaction           |
| `@omnis/validation` | 676        | 49      | The single validation door (Zod 4)                          |
| `@omnis/contracts`  | 1 120      | 72      | Envelope, commands, results, actor/tenant/execution context |
| `@omnis/events`     | 1 416      | 83      | Registry, 16 definitions, payload schemas, reference bus    |
| `@omnis/config`     | 517        | 55      | Schema-validated configuration, fail-fast in production     |
| `@omnis/logging`    | 571        | 45      | Structured, correlation-aware, redacting logging            |
| `@omnis/telemetry`  | 648        | 58      | Meters, instruments, tracers, spans, attribute derivation   |
| `@omnis/theme`      | 1 647      | 62      | Tokens and themes as pure data                              |
| `@omnis/ui`         | 3 403      | 166     | 15 accessible React components + `ThemeProvider`            |
| `studio`            | 899        | 54      | Operator surface: Aurora, Orb, branding, layout             |
| **Total**           | **14 133** | **815** | ~10 000 further lines of test code                          |

## 4. What Sprint 0 established

- **Identifiers**: 20 branded kinds over one ULID codec — see
  [03-contracts/IDENTIFIERS.md](03-contracts/IDENTIFIERS.md).
- **Errors**: typed, coded, retryable, redacted before serialization.
- **Contracts**: versioned envelope with mandatory tenancy and correlation; actor as a
  discriminated union; three-variant `CommandResult`.
- **Events**: grammar, ownership map, registry and reference-bus semantics — see
  [01-architecture/EVENT_ARCHITECTURE.md](01-architecture/EVENT_ARCHITECTURE.md).
- **Configuration**: environment-aware strictness; production fails closed.
- **Observability**: provider-independent interfaces plus validating no-ops, with a bounded
  metric vocabulary.
- **Design system**: framework-agnostic tokens and an accessible component library.
- **Governance**: five ADRs, a health checker and a secret scanner that make the rules
  mechanical.

## 5. Known gaps and deferred work

Tracked with reasons in
[05-implementation/DEVELOPMENT_WORKFLOW.md](05-implementation/DEVELOPMENT_WORKFLOW.md):

- Type-aware ESLint rules (`no-floating-promises` and friends) — Sprint 1.
- Coverage thresholds — after the domain packages exist.
- Durable event transport, outbox, dead-lettering — when a service needs them.
- Concrete telemetry backend — when deployment lands.
- CI matrix across Node versions — with a deployment target.
- happy-dom gaps (no `backdrop-filter`, `color-mix()` in shorthand) mean some visual
  behaviour cannot be asserted in unit tests; a browser-based visual check is not yet in CI.

## 6. Repository shape

```text
11 workspace members · 5 ADRs · 4 architecture documents · 2 contract documents
39 domain/subsystem specifications · 3 implementation guides · 1 CI workflow
3 workspace scripts (health, secrets, clean)
```

Nothing under `dist/`, `node_modules/` or `.turbo/` is tracked; the health checker fails if
that ever changes.
