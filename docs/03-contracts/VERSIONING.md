# Contract Versioning

Status: Accepted · Owner: `@omnis/contracts` · Current contract version: **1.0.0**

Events, commands and integration payloads outlive the code that produced them. A
character event written to the event store today must still be readable in two years,
by a consumer that has been rewritten several times, and possibly by a third-party
integration. That is only possible if every contract carries an explicit version and
if the rules for changing one are mechanical rather than a matter of opinion.

Implementation: [`packages/contracts/src/version.ts`](../../packages/contracts/src/version.ts),
[`packages/contracts/src/envelope.ts`](../../packages/contracts/src/envelope.ts).

## 1. The three kinds of change

| Kind             | Bump    | Rule                                                                                                                                                                                    | Example                                                                               |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Breaking**     | `MAJOR` | A consumer written for the previous major may misinterpret the record. Requires an ADR, a migration plan, and continued read support for the old major wherever records were persisted. | Removing a payload field; changing `costUsd` from USD cents to USD; narrowing an enum |
| **Additive**     | `MINOR` | Backwards compatible by construction. A consumer written for the earlier minor must keep working unchanged.                                                                             | Adding a nullable field; adding a member to an _open_ set; adding a new event type    |
| **Non-semantic** | `PATCH` | Documentation, descriptions, error-message wording. Never the shape.                                                                                                                    | Clarifying a JSDoc comment on a payload field                                         |

A contract is **never edited in place**. The previous version stays readable, and the
event registry refuses to redefine an existing `type@version`
(`ConflictError`) precisely so that a published contract cannot change meaning under
its consumers.

## 2. What "compatible" means in code

```ts
isBackwardsCompatible(previous, next)
```

Compatibility is exactly **same major, not older**:

- different major → incompatible, no promise exists in either direction;
- a pre-release `next` against a stable `previous` → incompatible, because a
  pre-release is not yet a stable contract;
- otherwise → compatible when `next >= previous`.

`assertInterpretableVersion` applies the same rule at the boundary: an envelope whose
`version` has a different major from the build's `CONTRACT_VERSION` is rejected with a
`ContractError` carrying both versions, rather than being parsed into a shape the
consumer will misread.

Two helpers keep bumps honest and identical everywhere:

- `classifyVersionChange(previous, next)` → `"patch" | "minor" | "major"`, used by
  review checklists to catch a change described as additive that actually moved the
  major — or, more dangerously, one that altered a shape while claiming to be a patch;
- `nextVersion(current, kind)` → the next version, centralised so "bump the minor"
  cannot be implemented as an off-by-one in one package.

## 3. Forward compatibility on the wire

An envelope is parsed with Zod's default object behaviour: **unknown fields are
stripped, not rejected**. A producer at minor `1.3` may therefore send fields a
consumer at `1.1` has never seen, and the consumer keeps working. Two consequences are
deliberate and are pinned by tests:

1. A consumer cannot read a field it does not know about — stripping means it is not
   present in the parsed value, so an accidental read fails loudly (`undefined`) rather
   than silently misinterpreting a renamed field.
2. A discriminated union (for example `CommandResult`, `ActorContext`) strips keys
   belonging to _other_ variants. That is the same forward-compatibility rule, and it
   is why a variant's own required field must still be present: absence of a required
   field is a rejection, not a strip.

**Corollary for producers:** never reuse a field name with a different meaning. Stripping
protects against _new_ fields, not against _redefined_ ones. A redefinition is a `MAJOR`.

## 4. `null` is part of the contract

Payload fields are `T | null`, never optional:

- an optional key disappears under `JSON.stringify`, so a consumer cannot distinguish
  "the producer omitted this" from "the producer asserted there is none";
- `T | undefined` is not JSON-representable, which would break every payload's
  assignability to `JsonObject`. `PayloadJsonSafetyAssertion` in
  [`packages/events/src/payloads.ts`](../../packages/events/src/payloads.ts) is a
  compile-time check that no payload violates this;
- `null` is also not `0`. A metric that was never reported is `null`; a metric that was
  reported as zero is `0`. Conflating them teaches the learning loop something false.

Adding a field as nullable-with-default is a `MINOR`. Making a nullable field mandatory
is a `MAJOR`.

## 5. Vocabulary governance

Some sets are **closed** and some are **open**, and the difference decides the bump:

| Set                                      | Kind                                                      | Adding a member                                                                            |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ERROR_CODE_VALUES`                      | closed                                                    | `MINOR` + ADR note. Removing or renaming one is `MAJOR`, because consumers branch on codes |
| `EVENT_SCOPES` (`domain`, `integration`) | closed                                                    | `MAJOR` — a new scope changes routing semantics                                            |
| `ACTOR_KINDS`                            | closed                                                    | `MAJOR` — authorization branches on kind                                                   |
| event types per namespace                | open                                                      | `MINOR`; a new type is additive by definition                                              |
| `SOCIAL_PLATFORMS`                       | open, with `PLANNED_SOCIAL_PLATFORMS` declared separately | `MINOR`; consumers must already handle an unknown platform defensively                     |
| identifier kinds                         | open, append-only                                         | `MINOR`; a prefix is never recycled, renamed or reused                                     |

## 6. Deprecation timeline

A deprecated contract stays **readable** for at least two minor versions and one major
cycle:

1. **Announce** — mark the definition deprecated in code and in
   [CHANGELOG.md](../../CHANGELOG.md), naming the replacement.
2. **Stop producing** — producers move to the replacement first; consumers must already
   handle both.
3. **Stop consuming** — consumers remove the old path.
4. **Remove** — only at a `MAJOR` bump, with a migration note in the ADR.

Nothing is deleted while persisted records may still carry it. Removal from the registry
means "no longer produced or accepted at the boundary", not "erased from history".

## 7. Checklist for a contract change

- [ ] Classified with `classifyVersionChange`, and the bump matches the classification.
- [ ] Additive change: new field is nullable or defaulted; no field renamed or reused.
- [ ] Breaking change: ADR opened, migration plan written, old major still readable.
- [ ] Payload stays JSON-safe (`T | null`, no `undefined`, no class instances).
- [ ] No secrets, and no more personal data than the domain needs — see
      [SECURITY_BOUNDARIES.md](../01-architecture/SECURITY_BOUNDARIES.md).
- [ ] Tests pin the new rule, including the rejection case.
- [ ] [CHANGELOG.md](../../CHANGELOG.md) updated under the contract's package.
