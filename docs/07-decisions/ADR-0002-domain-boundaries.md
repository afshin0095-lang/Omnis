# ADR-0002: Domain Boundaries and Package Layering

- Status: Accepted
- Date: 2026-09-11
- Sprint: 0
- Related: [ADR-0000](ADR-0000-architecture-governance.md),
  [ADR-0003](ADR-0003-event-contracts.md),
  [ARCHITECTURE.md](../01-architecture/ARCHITECTURE.md),
  [PLATFORM_FOUNDATION.md](../01-architecture/PLATFORM_FOUNDATION.md),
  [DOMAIN_TAXONOMY.md](../02-domain-model/DOMAIN_TAXONOMY.md)

## Context

[ARCHITECTURE.md](../01-architecture/ARCHITECTURE.md) names 29 domains. A repository that
created 29 packages on day one would have 29 empty shells, 29 dependency graphs to argue
about, and no way to tell which boundary was real. Equally, a repository with one package
would let any module import any other, and the domain map would survive only as
documentation — which is how the pre-Sprint-0 repository ended up with a Vite starter
implementing "the OMNIS AI operating system".

The question Sprint 0 had to answer is therefore not "what are the domains?" but **"what
is the smallest set of boundaries that must be real now, and what rule decides where the
next one goes?"**

## Decision

### 1. Two kinds of package

- **Platform packages** — domain-neutral foundations every domain will use: identifiers,
  errors, validation, contracts, events, configuration, logging, telemetry, theme, UI.
  These exist in Sprint 0 because they are prerequisites for _any_ domain work and because
  their mistakes are the most expensive to undo.
- **Domain packages** — one per bounded domain (`character-os`, `agent-runtime`,
  `content-factory`, `audience-intelligence`, …). These are created **when the domain is
  implemented**, not before. An unimplemented domain has a specification in `docs/`, not a
  package in `packages/`.

### 2. Dependencies are layered, and the layers are strict

| Layer               | Contents                                                               | Rule                       |
| ------------------- | ---------------------------------------------------------------------- | -------------------------- |
| 0 primitives        | `@omnis/types`, `@omnis/theme`                                         | depend on nothing internal |
| 1 errors            | `@omnis/errors`                                                        | may use layer 0            |
| 2 validation        | `@omnis/validation`                                                    | may use layers 0–1         |
| 3 contracts         | `@omnis/contracts`                                                     | may use layers 0–2         |
| 4 platform services | `@omnis/events`, `@omnis/config`, `@omnis/logging`, `@omnis/telemetry` | may use layers 0–3         |
| 5 presentation      | `@omnis/ui`                                                            | may use layers 0–1         |
| 6 apps              | `studio`                                                               | may use anything below     |

A member may depend **only on strictly lower layers**. Same-layer dependencies are refused,
which makes a cycle structurally impossible rather than merely unlikely. Domain packages
will be added at a layer above the platform (layer 5+, alongside or below presentation as
appropriate) and may depend on the platform but never on `apps/` or on each other except
through contracts and events.

### 3. Cross-domain communication uses contracts or events — never imports

A domain may not import another domain's internals. It may:

- consume a shared **contract** from `@omnis/contracts` (envelopes, commands, results,
  execution context);
- publish or subscribe to a versioned **event** it does not own
  ([ADR-0003](ADR-0003-event-contracts.md));
- call another domain through an **explicit interface** it declares and the other domain
  implements.

This is what makes future distribution possible without rewriting the contracts: if two
domains already communicate only through serialized contracts and events, moving one to
another process is a transport change, not a redesign.

### 4. Technology ownership is part of the boundary

| Technology            | Owner                        | Reason                                                                        |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Zod                   | `@omnis/validation`          | one validation door; the technology must be replaceable in one place          |
| React                 | `@omnis/ui`, `studio`        | the theme stays framework-agnostic so it can serve desktop and mobile clients |
| vendor AI SDKs        | nowhere in Sprint 0          | provider independence; adapters arrive behind a provider contract             |
| CSS custom properties | `@omnis/theme` (`--omnis-*`) | one canonical naming scheme, emitted from tokens                              |

A package that needs a technology it does not own gets an interface, not a dependency.

### 5. The health checker owns the rule

The layer table is encoded in `scripts/check-workspace-health.mjs` (`LAYERS`,
`TECHNOLOGY_OWNERS`). A new package that has not been assigned a layer **fails the gate**,
which forces the layer decision to be made explicitly and reviewed, instead of being
implied by whatever import somebody wrote first.

## Alternatives considered

**One package per domain, created up front (29 packages).** Rejected: empty shells provide
no boundary enforcement, and the real boundaries only become visible once code exists. It
also front-loads 29 naming decisions that would have to be revisited.

**A single `src/` with folder-based domains.** Rejected: folders do not prevent imports.
The pre-Sprint-0 repository demonstrated that a documented boundary with no mechanical
enforcement is not a boundary.

**Nx-style project graph with implicit boundaries.** Rejected for now: the same enforcement
is achievable with a 50-line table in the health checker, without adopting a second build
system. If the workspace grows past roughly 30 packages, revisit.

**Allowing same-layer dependencies.** Rejected: it is how cycles start. Two platform
services that need each other are telling you a third abstraction is missing — for example,
`@omnis/telemetry` does not depend on `@omnis/logging`; they meet at `@omnis/contracts`.

**Putting the theme in `@omnis/ui`.** Rejected: it would make every non-React client
consume React to obtain design tokens. `@omnis/theme` is pure data at layer 0 for exactly
this reason.

## Consequences

**Positive**

- A new contributor can answer "where does this code go?" from the layer table.
- Cross-domain coupling is visible in `package.json` and rejected by a gate.
- Domains can be implemented, and later distributed, independently.
- The theme and identifier packages can serve clients that will never run React.

**Negative / accepted costs**

- Some conveniences require an extra abstraction: a platform service that wants to log must
  accept a logger interface rather than import `@omnis/logging`.
- The layer table is a second place to update when a package is added. Accepted: that
  update _is_ the architectural decision, and the gate makes skipping it impossible.
- 29 domains remain documentation-only until implemented. Accepted deliberately; a
  specification is the right artefact for a domain that has no code.

## Compliance

`pnpm verify:workspace` fails on a same-layer or upward dependency, a cycle, a package
missing from the layer table, an application depended on by a library, or a technology used
outside its owner. Changing a layer assignment requires a superseding ADR.
