# Project Status

Authoritative snapshot of what exists **right now**. Updated at the end of every Sprint.
This document is deliberately blunt about what is _not_ built: a status page that implies
capability the repository does not have is worse than no status page.

Last updated: Sprint 1 complete · 2026-09-22

## 1. Summary

| Area                                                                             | State                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Repository foundation (monorepo, toolchain, gates)                               | **Complete**                                                              |
| Platform packages (Sprint 0)                                                     | **Complete**                                                              |
| AI Core packages (Sprint 1, 12 packages)                                         | **Complete** — provider-independent execution architecture                |
| `ai.*` event namespace                                                           | **Complete** — 22 event types, all defined                                |
| Architecture / integration / contract test suites (`tests/`)                     | **Complete**                                                              |
| Studio operator surface                                                          | **Foundation + AI Core feature seam** (client, mock runtime, view models) |
| Documentation (architecture, contracts, ADRs 0000–0009)                          | **Complete** for Sprint 0 + Sprint 1 scope                                |
| CI                                                                               | GitHub Actions workflow running the full gate on push and pull request    |
| Domain implementations (Character OS, Content Factory, Publishing, Analytics, …) | **Not started** — specifications only                                     |
| Durable event transport, database, queues                                        | **Not started** — the in-memory bus is a reference implementation         |
| Provider integrations (OpenAI, Anthropic, Google, platforms)                     | **None** — deliberate; no vendor SDK is installed anywhere                |
| Deployment                                                                       | **Not started**                                                           |
| Sprint 2 (Digital Human / Character OS)                                          | **Not started**                                                           |

## 2. Quality gates

| Gate             | Command                          | Result                             |
| ---------------- | -------------------------------- | ---------------------------------- |
| Install          | `pnpm install --frozen-lockfile` | pass                               |
| Build            | `pnpm build`                     | pass                               |
| Typecheck        | `pnpm typecheck`                 | pass                               |
| Lint             | `pnpm lint`                      | pass, `--max-warnings=0`           |
| Test             | `pnpm test`                      | pass (package + `tests/` + studio) |
| Workspace health | `pnpm verify:workspace`          | pass                               |
| Secret scan      | `pnpm verify:secrets`            | pass                               |
| Combined         | `pnpm check`                     | pass                               |

Exact counts are recorded in the Sprint 1 completion report and CHANGELOG; re-run the
gates rather than trusting a stale number in prose.

## 3. Packages

### Sprint 0 — platform foundation

| Package             | Role                                                  |
| ------------------- | ----------------------------------------------------- |
| `@omnis/types`      | Branded identifiers, value types, JSON guards         |
| `@omnis/errors`     | Typed error hierarchy + redaction                     |
| `@omnis/validation` | Zod door + issue redaction                            |
| `@omnis/contracts`  | Event envelope, actor/tenant/execution contexts       |
| `@omnis/events`     | Registry, bus, Sprint 0 + Sprint 1 `ai.*` definitions |
| `@omnis/config`     | Typed configuration                                   |
| `@omnis/logging`    | Structured logging                                    |
| `@omnis/telemetry`  | Spans + `omnis.ai.*` attributes                       |
| `@omnis/theme`      | Design tokens                                         |
| `@omnis/ui`         | Component library                                     |
| `studio`            | Operator surface                                      |

### Sprint 1 — AI Core

| Package                     | Role                                      |
| --------------------------- | ----------------------------------------- |
| `@omnis/ai-core-types`      | AI vocabulary (pure data)                 |
| `@omnis/execution-context`  | Scopes, cancellation, deadlines, metadata |
| `@omnis/model-registry`     | Model catalogue                           |
| `@omnis/provider-registry`  | Provider catalogue + `ProviderAdapter`    |
| `@omnis/policy-engine`      | Authorisation, fail-closed gate           |
| `@omnis/budget-engine`      | Micro-USD budgets, reservations           |
| `@omnis/ai-evaluation`      | Deterministic rule evaluation             |
| `@omnis/tool-runtime`       | Gated tool invocation                     |
| `@omnis/execution-kernel`   | Planned step execution                    |
| `@omnis/model-orchestrator` | Model pipeline, fallback, streaming       |
| `@omnis/agent-runtime`      | Agent state machine + planning            |
| `@omnis/ai-core-runtime`    | Composition root                          |

## 4. Studio AI Core seam

`apps/studio/src/features/ai-core/`:

- view models + formatters (`types.ts`)
- transport client that never throws (`client.ts`)
- deterministic mock backend (`mockRuntime.ts`)
- barrel (`index.ts`)

Foundation welcome page lists both foundation and AI Core packages.

## 5. What is deliberately not built

- No OpenAI / Anthropic / Google SDK
- No Character OS / Digital Human implementation (Sprint 2)
- No durable queue, database or multi-tenant control plane
- No production HTTP API in front of `ai-core-runtime` (Studio uses a mock transport)
- No LLM-as-judge evaluation
- No multi-agent mesh collaboration runtime

## 6. Enforcement

- Layer table and `FORBIDDEN_DEPENDENCIES` in `scripts/check-workspace-health.mjs`
- Source import scan, empty-file / placeholder scan, AI event registration pairing
- `tests/architecture`, `tests/integration`, `tests/contract`
- Secret scan with audited fixtures only
