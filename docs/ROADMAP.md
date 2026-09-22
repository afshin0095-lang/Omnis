# Roadmap

What is built, what comes next, and the reasoning behind the order. The order is not a
wishlist: each Sprint exists to remove a specific risk before the next one becomes
expensive.

## Completed

### Sprint 0 — Foundation, audit and production architecture bootstrap

**Goal:** make the repository capable of carrying a 29-domain platform, and prove it.

Delivered: the pnpm/Turborepo monorepo and its gates; eleven platform packages (types,
errors, validation, contracts, events, config, logging, telemetry, theme, ui) plus the
Studio foundation; documentation set (architecture, contracts, ADRs 0000–0004);
mechanical enforcement of layering, version discipline, documentation integrity and secret
hygiene; CI.

Deliberately **not** delivered: any product feature, any provider integration, any durable
transport, any database.

**Why first:** identifiers, event envelopes and dependency graphs are expensive to retrofit
once persisted data and other packages depend on them.

### Sprint 1 — AI Core foundation

**Goal:** a provider-independent execution architecture — the kernel every agent runs on.

**Delivered packages:** `ai-core-types`, `model-registry`, `provider-registry`,
`execution-context`, `policy-engine`, `budget-engine`, `ai-evaluation`, `tool-runtime`,
`execution-kernel`, `model-orchestrator`, `agent-runtime`, `ai-core-runtime`.

**Also delivered:**

- `ai.*` event namespace (22 types) in `@omnis/events`
- telemetry attributes `omnis.ai.*`
- new identifier kinds (model, provider, tool, policy, budget, reservation, evaluation, plan)
- architecture, integration and contract test suites under `tests/`
- workspace health rules for AI Core layers, forbidden vendor deps, event registration pairing
- Studio feature seam (`features/ai-core`) with client, mock runtime and view models
- contracts `docs/03-contracts/AI_*.md`, architecture docs, ADRs 0005–0009

**Invariants held:** policy before privileged execution; budget before expensive work;
tools only through Tool Runtime; models only through Model Orchestrator; no vendor SDK;
correlation/causation preserved; retries classified and bounded; money as integer micro-USD.

**Exit criteria met:** an agent execution can be planned, authorised, budgeted, run through
a deterministic kernel, evaluated and reported — end to end in tests, with no provider
installed.

## Next

### Sprint 2 — Digital Human / Character OS foundation

Identity, personality, traits, habits, preferences, values, beliefs, memory, experience,
timeline, relationships, knowledge, skills, emotion, health state, evolution and
versioning. Depends on Sprint 1 for execution and on Sprint 0 for identity, events and
storage contracts.

**Not started.** Do not begin until Sprint 1 gates remain green.

### Later (ordered by dependency risk)

- Provider adapter packages (OpenAI, Anthropic, …) behind `ProviderAdapter`
- Durable event transport and persistence
- Content Factory and production pipelines
- Publishing / platform orchestration
- Audience intelligence and growth
- Deployment and multi-tenant control plane

## Reading order for newcomers

1. [README.md](README.md) / repository [README](../README.md)
2. [PROJECT_STATUS.md](PROJECT_STATUS.md)
3. [01-architecture/ARCHITECTURE.md](01-architecture/ARCHITECTURE.md)
4. [01-architecture/AI_CORE_ARCHITECTURE.md](01-architecture/AI_CORE_ARCHITECTURE.md)
5. ADRs 0005–0009 for why the AI Core is shaped this way
