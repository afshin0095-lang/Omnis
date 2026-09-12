# ADR-0003: Event Contracts

- Status: Accepted
- Date: 2026-09-11
- Sprint: 0
- Related: [EVENT_ARCHITECTURE.md](../01-architecture/EVENT_ARCHITECTURE.md),
  [VERSIONING.md](../03-contracts/VERSIONING.md),
  [IDENTIFIERS.md](../03-contracts/IDENTIFIERS.md),
  [ADR-0002](ADR-0002-domain-boundaries.md)

## Context

OMNIS domains must communicate without depending on each other, and one business operation
("turn an audience request into a published video") crosses six domains over hours. Events
are the mechanism, and events are also the records that survive longest: a persisted event
must be readable in two years by code that has been rewritten several times.

Three failure modes drove this decision:

1. **Naming drift.** Without a grammar, `character.created`, `CharacterCreated`,
   `character_created` and `character.created.v2` all appear in one stream, and routing,
   grouping and ownership all stop working.
2. **Silent absence.** A producer emitting a type nobody defined is either dropped or, worse,
   interpreted by a consumer that guessed its shape.
3. **Semantic ambiguity on the wire.** An omitted field, a `null` field and a zero-valued
   field mean three different things, and JSON erases the difference between the first two.

## Decision

### 1. Event types are validated values with a grammar

`<domain>.<subject>[.<qualifier>...]`, matched against `^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$`:
lowercase alphanumeric dot-separated segments, at least two, no underscores, no hyphens, no
camelCase, no version suffix. `EventType` is a branded type produced only by
`parseEventType`, so an unvalidated string cannot be used as an event type. The first
segment must be one of seven namespaces: `system`, `agent`, `character`, `audience`,
`content`, `publishing`, `analytics`.

Versions live in the `version` field, never in the name.

### 2. Every event type has exactly one owner

`EVENT_OWNERS` maps each namespace to a service name (`omnis.platform`, `ai-core`,
`character-os`, `audience-intelligence`, `content-factory`, `publishing`, `analytics`).
Only the owner defines events in its namespace; any consumer may subscribe. Ownership is
recorded on the definition and named in validation errors. Enforcing `envelope.source`
against the owner at the boundary is deliberately **not** done in Sprint 0 — a gateway may
legitimately republish on another service's behalf — and belongs to the Policy Engine if it
is ever required.

### 3. Definitions are registered, and registration is the publish gate

`EventRegistry` holds `type@version → definition` (owner, scope, payload schema). Re-
registering an existing `type@version` throws `ConflictError`; a published contract must
not change meaning. `find(type)` returns the highest version (right for a producer),
`find(type, version)` returns a specific one (right for a consumer that understands only an
older shape). `require` throws `NotFoundError`. The registry exposes sorted copies, never
its internal maps.

The bus validates **before dispatch**: an unregistered type or an invalid payload means no
handler runs.

### 4. One envelope, mandatory attribution

`id`, `type`, `version`, `scope`, `occurredAt`, `source`, `tenantId`, `correlationId`,
`causationId | null`, `actor | null`, `payload`. `tenantId` and `correlationId` are
mandatory: there is no code path that produces an unattributed record. `scope` is `domain`
(internal reasoning, freer to change) or `integration` (crosses a boundary, part of the
public contract).

Compatibility is **same major**: `assertInterpretableVersion` rejects an envelope whose
major differs from the build's `CONTRACT_VERSION` (`1.0.0`) with a `ContractError` naming
both versions.

### 5. Payload rules

1. `T | null`, never optional — an optional key disappears under `JSON.stringify`, erasing
   the difference between "omitted" and "asserted none". `PayloadJsonSafetyAssertion` is a
   compile-time check that every payload type is `JsonObject`-assignable, which is what
   makes the rule enforceable rather than aspirational.
2. `null` is not `0` — `costUsd: null` means "not priced yet", `0` means "free"; an
   unreported metric is `null`, not zero. Budget enforcement and strategy learning both
   depend on the distinction.
3. No nested serialized errors — a failure carries its _classification_ (`errorCode`,
   `errorMessage`, `retryable`); a consumer needing the diagnostic follows `correlationId`.
4. No duplicated envelope fields — `actor`, `tenantId`, `correlationId`, `occurredAt` live
   on the envelope only.
5. No secrets and no more personal data than the domain needs — audience authors are opaque
   handles; configuration events carry key **names**, never values.

### 6. Unknown fields are stripped, not rejected

Forward compatibility: a producer at a higher minor may add fields and an older consumer
keeps working. The same applies to discriminated unions, which strip keys belonging to other
variants — while a variant's _own_ required field must still be present.

### 7. Sprint 0 ships a reference bus, not a transport

`InMemoryEventBus` is single-process and loses everything on restart. It exists to fix the
semantics a durable transport will be judged against: validate-before-dispatch, sequential
delivery in subscription order, failure isolation between handlers, a non-retryable
`ExecutionError` that reports `failureCount`/`handlerCount` with the correlation attached,
"no subscribers is not an error", and idempotent unsubscribe. No partitioning, consumer
groups, delivery guarantees, dead-lettering or outbox — those are transport concerns, and a
transport can be replaced while a persisted event format cannot.

## Alternatives considered

**CloudEvents as the envelope.** Rejected: it is a fine transport envelope but leaves
tenancy, actor, causation and payload versioning unspecified, and its `data` is `any`. OMNIS
needs those four to be mandatory and typed. The envelope is intentionally mappable to
CloudEvents if an external consumer ever requires it.

**Free-form string event names.** Rejected: this is failure mode 1, and it is unrecoverable
once events are persisted.

**Version in the event name (`character.created.v2`).** Rejected: it makes the name and the
version disagree, breaks grouping in dashboards, and multiplies subscription topics per
version.

**One payload schema per consumer.** Rejected: the producer's contract is the thing that
must be stable; per-consumer schemas would let two consumers of the same event disagree
about what it means.

**A durable transport in Sprint 0 (Kafka/NATS/Postgres outbox).** Rejected: choosing a
transport before the contract is fixed optimises the cheap part. The registry, grammar and
envelope are the expensive decisions, and they are transport-independent.

**Rejecting unknown envelope fields.** Rejected: it would make every additive producer
change a coordinated deploy across all consumers — the opposite of forward compatibility.

## Consequences

**Positive**

- A malformed or undefined event cannot reach a consumer; the failure is a typed error at
  the producer.
- Ownership is explicit, so "who may change this event?" has one answer.
- Payloads are JSON-safe by construction and provably so at compile time.
- Adding an event is a five-step, reviewable change with tests, not a design debate.

**Negative / accepted costs**

- Verbosity: `payload.costUsd: null` rather than an omitted field. Accepted — it is the point.
- A type may exist in a namespace table before it is registered, which can read as
  inconsistency. Accepted: the vocabulary and the publishable contract are different things,
  and only registration makes a type publishable.
- Sequential in-process delivery is not representative of a distributed transport's
  concurrency. Documented explicitly so no consumer relies on delivery order.
- Sixteen registered definitions cover Sprint 0 only; roughly twenty declared types await
  payload contracts. That is intentional and visible in the ownership table.

## Compliance

Grammar and vocabulary consistency are asserted by `packages/types` tests and by
`packages/events/src/registry.test.ts`; envelope and payload rules by
`packages/contracts` and `packages/events` tests; delivery semantics by
`packages/events/src/bus.test.ts`. Changing a decision here requires a superseding ADR and,
where records were persisted, continued read support for the old major.
