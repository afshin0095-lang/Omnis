# Identifiers

Status: Accepted · Owner: `@omnis/types` · Contract version: 1.0.0

Every persistent thing in OMNIS has one identifier, minted by one codec, in one
format. This document is the contract; the implementation is
[`packages/types/src/identifiers.ts`](../../packages/types/src/identifiers.ts) and
[`packages/types/src/ulid.ts`](../../packages/types/src/ulid.ts).

## 1. Why identifiers are a contract and not a detail

OMNIS is a distributed system whose records outlive the processes that wrote them.
A character event written today must still be readable in two years, must be joinable
to the execution that produced it, and must never be confusable with an identifier of
a different kind. Three properties deliver that:

1. **Self-describing.** The kind is visible in the value, so a log line, a URL and a
   database row can be read without consulting a schema.
2. **Sortable by time.** Creation order is recoverable from the value itself, which
   makes event streams, audit logs and character timelines queryable without a
   secondary ordering column.
3. **Type-incompatible across kinds.** A `CharacterId` is not a `ContentId` at compile
   time, so a transposed argument is a build failure rather than a production
   incident that reads the wrong row.

## 2. Format

```text
<prefix>_<26-character Crockford base32 ULID>
   3        1                    26          = 30 characters total
```

Example: `chr_01JQZ8M4K7N3P9R2S5T8V1W4X6`

| Component  | Rule                                                            | Why                                                                                                       |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| prefix     | exactly 3 lowercase characters, unique per kind, never recycled | Existing values embed it; recycling a prefix would make old data ambiguous                                |
| separator  | `_`                                                             | Visually separates kind from entropy, and is URL-, filename- and shell-safe                               |
| body       | 26 characters of Crockford base32 (`0-9A-HJKMNP-TV-Z`)          | Excludes `I`, `L`, `O`, `U` so a human transcribing an identifier cannot create a valid-looking wrong one |
| time       | first 10 characters = 48-bit millisecond timestamp              | Lexicographic order equals chronological order                                                            |
| randomness | last 16 characters = 80 bits from a CSPRNG                      | Collision-resistant without coordination                                                                  |

Total entropy is 128 bits, so identifiers can be minted independently in any process
without a central allocator.

### Monotonicity

`createMonotonicUlid` never returns a value that sorts before one it has already
returned **within the same process**, even if the wall clock jumps backwards (NTP
correction, VM migration, a restored snapshot). Where several identifiers are minted
in the same millisecond and their relative order matters — event streams, audit logs,
character timelines — the monotonic generator is the one to use. Across processes,
order comes from the timestamp and, where that ties, from the sequence in which events
were appended; never from string comparison alone.

## 3. Kinds

Twenty kinds are defined. The prefix is the wire form; the branded type is what code
passes around.

| Kind             | Prefix | Branded type        | Owned by               |
| ---------------- | ------ | ------------------- | ---------------------- |
| entity           | `ent`  | `EntityId`          | Data Platform          |
| tenant           | `ten`  | `TenantId`          | Control Plane          |
| user             | `usr`  | `UserId`            | Identity               |
| workspace        | `wks`  | `WorkspaceId`       | Control Plane          |
| character        | `chr`  | `CharacterId`       | Character OS           |
| agent            | `agt`  | `AgentId`           | Agent Runtime          |
| content          | `cnt`  | `ContentId`         | Content Factory        |
| channel          | `chn`  | `ChannelId`         | Social OS              |
| platform account | `pac`  | `PlatformAccountId` | Social OS              |
| execution        | `exe`  | `ExecutionId`       | Agent Runtime          |
| command          | `cmd`  | `CommandId`         | Contracts              |
| event            | `evt`  | `EventId`           | Event Bus              |
| correlation      | `cor`  | `CorrelationId`     | Contracts              |
| causation        | `cau`  | `CausationId`       | Contracts              |
| job              | `job`  | `JobId`             | Workflow Engine        |
| approval         | `apr`  | `ApprovalId`        | Policy / Control Plane |
| opportunity      | `opp`  | `OpportunityId`     | Strategy & Growth      |
| request          | `req`  | `ContentRequestId`  | Audience Intelligence  |
| trace            | `trc`  | `TraceId`           | Observability          |
| span             | `spn`  | `SpanId`            | Observability          |

### Causation is deliberately permissive

A `CausationId` answers "which immediate trigger caused this execution?" The trigger is
either a command or an event, so the causation schema accepts `cau_`, `cmd_` and `evt_`
prefixed values and `asCausationId` re-labels an `EventId` or `CommandId` as a cause
**without changing its value**. Forcing a distinct `cau_` identifier would break the
join back to the record that actually caused the work — the whole point of the field.

## 4. Invariants

These are enforced by the codec and by tests, not by convention.

1. A `string` is never an identifier. It becomes one only through `parseIdentifier`,
   `tryParseIdentifier` or a `create*Id` factory. Branded types make an unparsed string
   a compile error at every boundary.
2. Parsing is strict: wrong prefix, wrong length, a character outside the Crockford
   alphabet, or a separator in the wrong place all fail with `InvalidIdentifierError`.
3. Identifiers are opaque. Nothing may derive meaning from the body beyond ordering;
   the kind comes from the prefix, and the prefix table is the only authority.
4. Identifiers are not secrets and not personal data. They may appear in URLs, logs,
   events and metrics **as span attributes**. They must never become metric labels —
   see [PLATFORM_FOUNDATION.md](../01-architecture/PLATFORM_FOUNDATION.md) and the
   cardinality rule in `@omnis/telemetry`.
5. Prefixes are never reused, never renamed and never lengthened. Adding a kind is
   additive: one entry in `IDENTIFIER_KINDS`, one branded alias, one factory.
6. Every record is attributable. `tenantId` and `correlationId` are mandatory on
   events, commands, log records and spans; there is no code path that produces an
   unattributed record.

## 5. Usage

```ts
import { createCharacterId, parseIdentifier, identifierKindOf } from "@omnis/types";

// Minting: one call, cryptographically random, monotonic within the process.
const characterId = createCharacterId(); // "chr_01JQZ8M4K7N3P9R2S5T8V1W4X6"

// Parsing at a boundary (HTTP input, queue message, database row).
const parsed = parseIdentifier("character", request.body.characterId);

// Non-throwing form for validation pipelines.
const result = tryParseIdentifier("character", unknownValue);
if (!result.ok) {
  // result.reason describes exactly what was wrong, without echoing the value.
}

// Inspecting an identifier you did not mint.
identifierKindOf("chr_01JQZ8M4K7N3P9R2S5T8V1W4X6"); // "character"
```

## 6. Adding a kind

1. Add the kind and its 3-character prefix to `IDENTIFIER_KINDS`.
2. Add the branded alias and its `create*Id` factory.
3. Add it to `IdentifierTypeMap` so `parseIdentifier` stays type-safe.
4. Add tests: round-trip, rejection of a wrong prefix, rejection of a malformed body,
   and lexicographic ordering by time.
5. If the kind crosses a domain boundary, record it in the table above and open an ADR
   when the addition changes who may mint it.

Never choose a prefix that could be confused with an existing one when read aloud or
glanced at (`chr` / `chn` is already the closest pair in the table and is the reason
both are spelled out in full in documentation).

## Sprint 1 kinds

Additional kinds owned by the AI Core (same format rules as above):

| Kind        | Prefix | Owner package     |
| ----------- | ------ | ----------------- |
| model       | `mdl`  | model-registry    |
| provider    | `prv`  | provider-registry |
| tool        | `tol`  | tool-runtime      |
| policy      | `pol`  | policy-engine     |
| budget      | `bud`  | budget-engine     |
| reservation | `rsv`  | budget-engine     |
| evaluation  | `evl`  | ai-evaluation     |
| plan        | `pln`  | execution-kernel  |

Implementation: `packages/types/src/identifiers.ts`.
