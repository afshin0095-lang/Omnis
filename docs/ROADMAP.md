# Roadmap

What is built, what comes next, and the reasoning behind the order. The order is not a
wishlist: each Sprint exists to remove a specific risk before the next one becomes
expensive.

## Completed

### Sprint 0 — Foundation, audit and production architecture bootstrap

**Goal:** make the repository capable of carrying a 29-domain platform, and prove it.

Delivered: the pnpm/Turborepo monorepo and its gates; eleven platform packages (types,
errors, validation, contracts, events, config, logging, telemetry, theme, ui) plus the
Studio foundation; 815 tests; the documentation set (architecture, contracts, five ADRs);
mechanical enforcement of layering, version discipline, documentation integrity and secret
hygiene; CI.

Deliberately **not** delivered: any product feature, any provider integration, any durable
transport, any database. See [PROJECT_STATUS.md](PROJECT_STATUS.md).

**Why first:** every one of these is expensive to retrofit. An identifier scheme, an event
envelope and a dependency graph are all things that persisted data and other people's code
come to depend on; changing them later is a migration, not a refactor.

## Next

### Sprint 1 — AI Core foundation

**Goal:** a provider-independent execution architecture — the kernel every agent runs on.

Planned packages: `ai-core-types`, `model-registry`, `provider-registry`,
`execution-context`, `agent-runtime`, `tool-runtime`, `policy-engine`, `budget-engine`,
`execution-kernel`, `model-orchestrator`, `ai-evaluation`, composed by `ai-core-runtime`.

Invariants Sprint 1 must hold: policy is evaluated **before** privileged execution; budget
is checked **before** expensive work; tools run only through the Tool Runtime; models run
only through the Model Orchestrator; no vendor SDK appears in domain code; every execution
preserves correlation and causation; retries are classified, never blind.

**Exit criteria:** an agent execution can be planned, authorised, budgeted, run through a
deterministic kernel, evaluated and reported — end to end in tests, with no provider
installed.

### Sprint 2 — Digital Human / Character OS foundation

Identity, personality, traits, habits, preferences, values, beliefs, memory, experience,
timeline, relationships, knowledge, skills, emotion, health state, evolution and
versioning. Depends on Sprint 1 for execution and on Sprint 0 for identity, events and
storage contracts.

### Sprint 3+ — planned sequence

1. **Memory & Knowledge** — the fabric a character's continuity depends on.
2. **Content Factory** — research → brief → script → media → QA → master.
3. **Social & Publishing** — platform adapters behind the provider abstraction, approval
   gates, confirmed publication.
4. **Audience Intelligence** — signals, requests, clusters, loyalty, opportunities.
5. **Strategy, Analytics & Growth** — measurement, scoring, experimentation, learning.
6. **Control Plane & Deployment** — tenancy administration, infrastructure, real telemetry
   and event backends.

## Ordering rules

- **Contracts before implementations.** A domain is specified before it is packaged.
- **Foundations before features.** Anything persisted, or depended on by two domains, is
  settled first.
- **Abstractions before vendors.** The provider contract exists before any provider SDK is
  installed, so provider independence is a property of the design rather than a promise.
- **Gates before scale.** Every Sprint adds the checks that will catch its own mistakes; a
  Sprint that cannot verify itself is not finished.
- **No Sprint starts before the previous one is independently green.**
