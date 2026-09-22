# AI Providers

Status: Accepted · Owner: `@omnis/provider-registry` · Sprint: 1

How providers are registered, health-tracked and selected. No vendor SDK is imported
in this package or anywhere else in Sprint 1.

## 1. Adapter interface

A `ProviderAdapter` is the only shape the rest of OMNIS may depend on for model I/O.
It is defined in `@omnis/provider-registry` and deliberately free of vendor types.
Concrete adapters (OpenAI, Anthropic, …) are a later Sprint and will live in their own
packages behind this interface.

## 2. Lifecycle

```
registered → initializing → ready
                ↘ degraded ⇄ ready
                ↘ unavailable
any non-disabled → disabled → initializing
```

Only `ready` and (with lower weight) `degraded` providers are selectable. Disabled
providers produce a skipped attempt when they appear in a candidate list.

## 3. Health

`ProviderHealth` records consecutive successes/failures, last success/failure times,
average latency and observed state. Health is folded from invocation outcomes; it is
not a heartbeat ping in Sprint 1.

## 4. Selection scoring

Candidates are scored on capability match, availability, priority, health, cost and
policy. Tie-break is slug. Fallback ordering is the sorted candidate list; each
fallback re-validates policy and budget before the adapter is called.

## 5. Credentials

Whether credentials are configured is an operator fact (`credentialsConfigured:
boolean`). The credential value itself never appears in descriptors, events, logs or
Studio view models.
