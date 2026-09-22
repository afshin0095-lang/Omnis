# AI Models

Status: Accepted · Owner: `@omnis/model-registry` · Sprint: 1

How models are registered, resolved and selected. Calling a model is owned by the
Model Orchestrator; this contract is the catalogue.

## 1. Model reference

A model is addressed by a discriminated union:

```ts
type ModelReference =
  | { kind: "id"; value: ModelId }
  | { kind: "slug"; value: string }
  | { kind: "capability"; value: string };
```

Capability references are resolved at planning or selection time to a concrete model.
An agent plan pins the resolved model so a mid-run capability change cannot silently
substitute a different model.

## 2. Descriptor

A `ModelDescriptor` is immutable once registered (deep-frozen). It carries:

- identity (`id`, `slug`, `displayName`, `providerId`)
- kind and capabilities
- modalities (input / output)
- context window and max output tokens
- optional pricing (integer micro-USD per thousand tokens / per request)
- priority, latency class, status
- provider model name (opaque string for the adapter)
- metadata and registration time

## 3. Registry operations

`register` · `get` · `require` · `has` · `remove` · `list` · `findByCapability` ·
`findByProvider` · `resolve`

Duplicates are rejected. Resolution of an unknown reference throws `NotFoundError`.
Descriptors returned to callers are frozen; mutating them is a no-op at runtime and a
type error where possible.

## 4. Selection

Selection scoring lives in the provider registry and model orchestrator: capability
match, availability, priority, health, cost and policy. The model registry itself is a
pure catalogue — it does not decide whether a call may proceed.
