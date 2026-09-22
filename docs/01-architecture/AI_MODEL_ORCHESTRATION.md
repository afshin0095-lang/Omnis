# AI Model Orchestration

Status: Accepted · Owner: `@omnis/model-orchestrator` · Sprint: 1

The only path from the platform to a model provider.

## 1. Pipeline

```
ModelRequest
  → resolve model (registry)
  → select provider candidates (registry scoring)
  → policy gate
  → budget reserve (estimate)
  → provider adapter call
  → normalise result
  → budget commit
  → telemetry + events
```

On failure classified as retryable: bounded retry on the same candidate, then fallback
to the next candidate. **Each fallback re-runs policy and budget** before the adapter
is touched.

## 2. Fallback

- Disabled / unselectable providers produce a `skipped` attempt and count toward
  fallbacks.
- All-failed calls still report the model the call was _about_ (first candidate) and
  the full attempt trail.
- Agent runs do **not** fall back mid-run; the planner pinned the model. Fallback is a
  property of direct `executeModel` / orchestrator `call` / `stream` paths.

## 3. Streaming

`stream()` is an async generator of `ModelStreamEvent`. The policy/budget gate runs
**before** synthesis begins. An unterminated stream is a failure. Stream events:
`ai.model.stream.started|completed|failed`.

## 4. Usage accumulation

Empty (zero-consumption) usage from a failed attempt is **skipped** when folding so it
cannot null out a priced successful fallback's cost. See deviation log and
`ModelOrchestrator` unit tests.

## 5. Events

| Type                            | Meaning                           |
| ------------------------------- | --------------------------------- |
| `ai.model.call.completed`       | Success                           |
| `ai.model.call.failed`          | Exhausted candidates              |
| `ai.model.fallback.used`        | Moved to another candidate        |
| `ai.model.retry.scheduled`      | Another attempt on same candidate |
| stream started/completed/failed | Streaming lifecycle               |

## 6. Independence

The orchestrator depends on `ProviderAdapter`, never on a vendor SDK. Request/response
shapes are OMNIS types (`ModelRequest`, `ModelResponse`, `ModelCallResult`). Provider-
specific payloads stop at the adapter boundary.
