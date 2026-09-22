# Glossary

Canonical terminology. **One concept, one name.** When two documents disagree about a term,
this file wins, and the disagreement is a bug to fix rather than a style difference.

Terms that are deliberately _not_ synonyms are marked. Terms that carry two meanings inside
the industry are disambiguated explicitly, because ambiguity in a name becomes ambiguity in
an interface.

## Platform and structure

| Term                 | Meaning                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR**              | Architecture Decision Record. Required for any change to a domain boundary, a package dependency rule, a contract version or the toolchain. Lives in `docs/07-decisions/`.                                                                     |
| **Domain**           | A bounded area of responsibility with one owner — Character OS, Content Factory, Publishing. Not a package: a domain gets a package when it gets an implementation.                                                                            |
| **Gate**             | A mechanically enforced rule: `pnpm lint`, `typecheck`, `test`, `build`, `verify:workspace`, `verify:secrets`. A rule that is only written down is not a gate.                                                                                 |
| **Layer**            | A rung in the package dependency order. Dependencies point strictly downward; same-layer and upward dependencies are refused.                                                                                                                  |
| **OMNIS**            | The platform: an autonomous, continuously learning operating system for digital media, and the Digital Human platform inside it.                                                                                                               |
| **Package**          | A workspace member under `packages/` or `apps/` with its own manifest, tsconfigs and tests.                                                                                                                                                    |
| **Platform package** | A domain-neutral foundation (types, errors, validation, contracts, events, config, logging, telemetry, theme, ui).                                                                                                                             |
| **Sprint**           | A bounded delivery increment. Sprint 0 = foundation; Sprint 1 = AI Core; Sprint 2 = Digital Human / Character OS.                                                                                                                              |
| **Studio**           | The operator web surface (`apps/studio`): where a human watches, approves and steers the platform.                                                                                                                                             |
| **Workspace**        | Two distinct meanings, never interchangeable: (1) the pnpm workspace — the set of packages; (2) a `WorkspaceId` — a sub-scope inside a tenant grouping characters, channels and content. In prose, say "pnpm workspace" or "tenant workspace". |

## Records and identity

| Term                  | Meaning                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Actor**             | Who originated an action: `user`, `agent`, `service` or `system`. A discriminated union, because the identifiers each kind carries genuinely differ.                                         |
| **Autonomous action** | An action no human originated directly (`agent`, `service` or `system` actor). Not forbidden — it is the point of OMNIS — but it is the class of action that may require an approval gate.   |
| **Causation ID**      | The specific command or event that directly caused this execution. May carry a `cau_`, `cmd_` or `evt_` prefix; the value of the causing record is preserved so the join still works.        |
| **Correlation ID**    | Ties every record produced by one end-to-end business operation together, across many executions and possibly many days.                                                                     |
| **Envelope**          | The mandatory wrapper around every event: identity, type, version, scope, time, source, tenant, correlation, causation, actor, payload.                                                      |
| **Execution**         | One bounded run of an agent, tool or pipeline, with its own `ExecutionId`.                                                                                                                   |
| **Identifier**        | `<3-char prefix>_<26-char Crockford base32 ULID>`. Branded: a `string` is not an identifier until it has been parsed.                                                                        |
| **Payload**           | The event-specific content inside an envelope. Always a JSON object; fields are `T                                                                                                           | null`, never optional. |
| **Record**            | Any persisted or emitted artefact: event, command, log line, span. Every record is tenant-attributed.                                                                                        |
| **Tenant**            | The owning organisation or account boundary. OMNIS has no untenanted data.                                                                                                                   |
| **Trace / Span**      | The _technical_ chain (`traceId`/`spanId`), W3C-compatible. Distinct from the business chain (correlation/causation), because a trace ends with a request while a correlation can span days. |

## Events and contracts

| Term                         | Meaning                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contract**                 | A versioned agreement between domains: an event definition, a command shape, an API payload. Never edited in place.                                                                 |
| **Contract version**         | `CONTRACT_VERSION`, currently `1.0.0`. Compatibility is "same major, not older".                                                                                                    |
| **Definition**               | A registered `type@version` with its owner, scope and payload schema. Registration is what makes a type publishable.                                                                |
| **Event type**               | A validated dotted name, `<domain>.<subject>[.<qualifier>…]`, e.g. `character.experience.recorded`. Lowercase, alphanumeric, no underscores, no version suffix.                     |
| **Namespace**                | The first segment of an event type; there are seven (`system`, `agent`, `character`, `audience`, `content`, `publishing`, `analytics`) and each has exactly one owner.              |
| **Owner**                    | The service that defines events in a namespace. Any consumer may subscribe; only the owner may define.                                                                              |
| **Reference implementation** | A simple, in-process implementation whose _semantics_ are the contract — the in-memory event bus, the no-op telemetry. Not a mock, and not a production transport.                  |
| **Registry**                 | The authoritative in-memory index of definitions. Refuses duplicates, resolves the highest version by default, exposes copies rather than internals.                                |
| **Scope (event)**            | `domain` — internal to a domain's reasoning; `integration` — crosses a boundary and is part of the platform's public contract. Not to be confused with a _workspace scope_ in code. |
| **Vocabulary**               | A closed or open set of agreed values (`ERROR_CODE_VALUES`, `EVENT_NAMESPACES`, `ACTOR_KINDS`, `SOCIAL_PLATFORMS`). Whether it is open or closed decides the version bump.          |

## Errors, security and configuration

| Term              | Meaning                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cardinality**   | The number of distinct values a dimension can take. High-cardinality dimensions belong on spans, never on metric labels.                                                                 |
| **Configuration** | Typed, schema-validated runtime settings. In `production` a missing or invalid variable aborts startup; in development a documented default may apply.                                   |
| **Error code**    | A stable machine-readable classification from `ERROR_CODE_VALUES`. Consumers branch on codes, never on messages.                                                                         |
| **Fail closed**   | Refusing to proceed when something is unknown or invalid, rather than degrading into an insecure default.                                                                                |
| **Personal data** | Anything identifying or describing a person. OMNIS retains audience comment text because Audience Intelligence cannot function without it, and references authors by opaque handle only. |
| **Redaction**     | Replacing secret-shaped material with `[REDACTED]` before it reaches a log, an error or an event. Applied by the error hierarchy and the logger, never left to a call site.              |
| **Secret**        | A credential: API key, token, password, private key, connection string. Never in the repository, a log line, an event payload or an error message.                                       |
| **Typed error**   | An `OmnisError` subclass carrying a code, structured metadata, retryability and an optional cause. A bare `throw new Error(...)` in a core path is a defect.                             |

## Agents, models and tools

| Term              | Meaning                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**         | An executable autonomous unit with identity, instructions, capabilities, state, tools, policy and budget.                                           |
| **Approval gate** | A human decision required before a high-impact autonomous action. Decided when the work is queued, not when it executes, so a retry cannot skip it. |
| **Budget**        | A bounded allowance (tokens, requests, time, money, tool executions) checked **before** expensive work.                                             |
| **Capability**    | What an agent or model can do (`script.draft`, `structured-output`, `tool-calling`, `streaming`).                                                   |
| **Experience**    | A structured record of what happened to a character — the entry point of the evolution loop. Recorded as state, never improvised per generation.    |
| **Model Router**  | The component that selects a provider and model for a request. Domain code never selects a model directly.                                          |
| **Policy**        | A rule producing `allow`, `deny`, `require_approval` or `constrain`, evaluated **before** privileged execution.                                     |
| **Provider**      | An external model or platform service, reached only through an adapter. No vendor SDK appears in domain code.                                       |
| **Tool**          | A registered, permissioned, timeout-bounded operation an agent may invoke through the Tool Runtime. Never executed directly by an agent.            |

## Content, audience and growth

| Term                | Meaning                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Character**       | A persistent digital human owned by Character OS: identity, personality, memory, knowledge, appearance, relationships.                |
| **Content Factory** | The research-to-master production pipeline.                                                                                           |
| **Digital Human**   | A character presented as a virtual influencer, continuous across content, time and audience interaction.                              |
| **Loyalty tier**    | An audience member's standing, derived from repeated interaction. Built from an opaque handle, not an identity.                       |
| **Opportunity**     | A scored content opportunity raised by Audience Intelligence or Strategy.                                                             |
| **Publication**     | A piece of content confirmed live by a platform. "Submitted" is not "published": completion requires the platform's own confirmation. |
| **Signal**          | An inbound audience interaction (comment, DM) carrying text, an external identifier and an opaque author reference.                   |

## Presentation

| Term             | Meaning                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Design token** | A named, typed value in the theme system — a colour, spacing step, radius, shadow, motion duration.                                 |
| **Theme**        | A complete, composable set of tokens (`dark`, `light`, `aiStudio`). Pure data; framework-agnostic.                                  |
| **Token (LLM)**  | A model's unit of text, counted for cost. **Never** use "token" unqualified in AI Core prose: say "design token" or "model token".  |
| **`--omnis-*`**  | The canonical CSS custom property namespace emitted from theme tokens. The only naming scheme for CSS variables in this repository. |

## AI Core (Sprint 1)

| Term                   | Meaning                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI Core**            | The twelve packages that decide, govern and record AI work, plus the `ai.*` events and Studio projection seam. Provider-independent by design. |
| **Agent**              | A registered autonomous worker (`agt_…`) with a descriptor, ceilings and a table-driven lifecycle. Never calls providers or tools directly.    |
| **Budget**             | A ceiling on tokens, requests, time, money (micro-USD) or tool calls. Holds are reserved before work and committed or released after.          |
| **Execution kernel**   | Runs a dependency-ordered plan of steps; records attempts; enforces cancellation and deadlines.                                                |
| **Execution scope**    | AI-layer context: cancellation, deadline, child scopes, redaction-aware metadata. Distinct from the contracts `ExecutionContext`.              |
| **Micro-USD**          | Integer millionths of a US dollar. The only money unit in the AI Core. `null` means not priced; `0` means free.                                |
| **Model orchestrator** | Sole path to a provider adapter: selection, policy/budget, retry, fallback, streaming, normalisation.                                          |
| **Model reference**    | Discriminated address of a model: by id, slug or capability.                                                                                   |
| **Policy decision**    | `allow` \| `deny` \| `constrain` \| `require_approval`, with precedence deny > require_approval > constrain > allow.                           |
| **Provider adapter**   | Interface every model I/O goes through. No vendor SDK types above it.                                                                          |
| **Reservation**        | An idempotent hold against a budget (`rsv_…`), settled when work finishes.                                                                     |
| **Tool runtime**       | Permission + policy + budget gated tool invocation with timeout and result normalisation.                                                      |
| **View model**         | Studio projection of AI Core data (strings/numbers/booleans). Not a domain type; no `@omnis/ai-core-types` import in the feature.              |
