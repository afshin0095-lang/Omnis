# Changelog

All notable changes to OMNIS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — see
[docs/03-contracts/VERSIONING.md](docs/03-contracts/VERSIONING.md) for what counts as a breaking change.

## [Unreleased]

### Sprint 1 — AI Core foundation

#### Added

- **Twelve AI Core packages:** `@omnis/ai-core-types`, `execution-context`, `model-registry`,
  `provider-registry`, `policy-engine`, `budget-engine`, `ai-evaluation`, `tool-runtime`,
  `execution-kernel`, `model-orchestrator`, `agent-runtime`, `ai-core-runtime`.
- **Provider-independent execution:** `ProviderAdapter` interface; no vendor SDK anywhere.
- **Governance:** policy precedence (deny > require_approval > constrain > allow), fail-closed
  gate; integer micro-USD budgets with idempotent reservations.
- **Agent state machine** with legal transition table; planning pins capability→model; agents never
  call providers/tools directly.
- **Model orchestrator** with bounded retry, fallback (re-validates policy+budget), streaming.
- **Execution kernel** with dependency-ordered steps, hooks, cancellation, deadlines, recording.
- **Deterministic evaluation** (rules only; no LLM-as-judge).
- **`ai.*` events** (22 types) with definitions; telemetry `omnis.ai.*` attributes.
- **New identifier kinds:** model, provider, tool, policy, budget, reservation, evaluation, plan.
- **`tests/` workspace member:** architecture, integration (execution, policy-budget, fallback),
  contract (ai-core-events).
- **Workspace health:** AI Core layers, forbidden vendor deps, source import rules, AI event
  registration pairing, project-reference resolution.
- **Studio AI Core feature:** view models, transport client (`AiCoreResult`), deterministic mock
  runtime; welcome page lists AI Core packages.
- **Documentation:** `docs/03-contracts/AI_*.md`, `docs/01-architecture/AI_*.md`, ADRs 0005–0009;
  PROJECT_STATUS, ROADMAP, GLOSSARY, SUMMARY updated.

#### Invariants

- Policy before privileged execution; budget before expensive work.
- No unbounded retries; no silent failures; secrets never logged.
- Money: integer micro-USD; `null` (unpriced) ≠ `0` (free).

### Sprint 0 — foundation, audit and production architecture bootstrap

#### Added

- **Monorepo foundation.** pnpm workspaces + Turborepo, TypeScript `~6.0.3` in strict mode with
  `NodeNext` module resolution for libraries and `Bundler` for Vite apps, ESLint flat config with `--max-warnings=0`
  (syntax-only in Sprint 0; type-aware rules are tracked as Sprint 1 hardening),
  Prettier, EditorConfig, per-package
  `tsconfig.json` (no emit) and `tsconfig.build.json` (emit).
- **`@omnis/types`** — 20 branded identifier kinds over a Crockford base32 ULID codec, value types
  (trimmed strings, ISO-8601 timestamps, URIs, email addresses, semver, language tags, ratios,
  percentages), event-type and command-name grammars, environment and social-platform vocabularies,
  JSON value guards and secret-key detection.
- **`@omnis/errors`** — a 13-class `OmnisError` hierarchy with stable machine-readable codes,
  structured metadata, retryability, redaction before serialization and JSON round-tripping.
- **`@omnis/validation`** — the single validation door (Zod 4) with OMNIS primitive schemas, a typed
  `ValidationError`, issue redaction and schema-naming conventions.
- **`@omnis/contracts`** — `CONTRACT_VERSION 1.0.0`, the versioned `EventEnvelope`, the three-part
  `ActorContext` discriminated union, `TenantContext`, `ExecutionContext`, command contracts and the
  three-variant `CommandResult` union.
- **`@omnis/events`** — a versioned event registry with ownership, 16 Sprint 0 event definitions across
  7 namespaces, payload schemas for every defined type, and a validating in-memory bus that is the
  reference implementation for future durable transports.
- **`@omnis/config`** — schema-validated configuration with environment-aware strictness: production
  fails fast on a missing or invalid variable, development falls back to documented defaults.
- **`@omnis/logging`** — provider-independent structured logging with correlation context, level
  vocabulary and redaction on every emitted field.
- **`@omnis/telemetry`** — meters, counters, gauges, histograms, tracers and spans as interfaces, plus
  validating no-op implementations and execution-context attribute derivation with a bounded metric
  vocabulary.
- **`@omnis/theme`** — framework-agnostic design tokens (colour, typography, spacing, radius, shadows,
  motion, z-index, breakpoints, surfaces, components), the `dark`, `light` and `aiStudio` themes,
  runtime theme composition and `--omnis-*` CSS variable emission.
- **`@omnis/ui`** — 15 accessible React components (`Button`, `Card`, `Input`, `Badge`, `Panel`,
  `Surface`, `Stack`, `Text`, `Spinner`, `Modal`, `Tooltip`, `Divider`, `IconButton`, `Progress`,
  `EmptyState`), `ThemeProvider`, and `cn` / `composeRefs` utilities.
- **`apps/studio`** — the operator surface: Aurora background, animated orb, futuristic typography,
  logo and tagline, responsive root layout and welcome page, all driven by theme tokens and `motion`.
- **Tests.** 815 tests across 11 packages, including contract, vocabulary-consistency and
  integration coverage.
- **Documentation.** Numbered documentation set, four new ADRs, identifier and versioning contracts,
  event architecture, security boundaries and the platform foundation architecture.
- **Tooling.** `scripts/check-workspace-health.mjs`, `scripts/scan-secrets.mjs`,
  `scripts/clean-package.mjs` and a GitHub Actions CI workflow.

#### Changed

- Documentation reorganised into `docs/01-architecture`, `docs/02-domain-model`,
  `docs/03-contracts`, `docs/04-specifications`, `docs/05-implementation` and `docs/07-decisions`.

#### Fixed

- `audience.loyalty.tier_changed` violated the dotted-lowercase event grammar and threw at module
  load, making `@omnis/events` unimportable. Renamed to `audience.loyalty.tier.changed`.
- Causation identifiers rejected legitimate `evt_`/`cmd_` causes; a shared `causationIdSchema` now
  accepts any of the three prefixes.
- `NoopCounter` reported `-Infinity` as a decrease rather than as the non-finite measurement it is.
- Studio loaded leftover Vite template stylesheets instead of OMNIS global styles and theme.

#### Removed

- The previous `@omnis/theme` React provider and the CSS-first token pipeline (superseded by the
  framework-agnostic token package and `@omnis/ui`'s `ThemeProvider`).
- Vite starter artefacts: `index.css`, `themes.css`, `tokens.css`, `App.css`, `hero.png`,
  `react.svg`, `vite.svg`, duplicate per-package ESLint configs and PowerShell bootstrap scripts.

[Unreleased]: https://github.com/afshin0095-lang/Omnis/commits/main
