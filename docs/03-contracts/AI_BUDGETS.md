# AI Budgets

Status: Accepted · Owner: `@omnis/budget-engine` · Sprint: 1

How expensive work is bounded before it runs, and how consumption is settled after.

## 1. Units

| Dimension                           | Unit                                         |
| ----------------------------------- | -------------------------------------------- |
| Money                               | integer **micro-USD** (never floating point) |
| Tokens                              | integer token counts                         |
| Requests / model calls / tool calls | integer counts                               |
| Duration                            | milliseconds                                 |

`null` cost means "not priced". Once any side of a usage fold is `null`, the combined
cost stays `null` unless empty (zero-consumption) usage is skipped — the model
orchestrator does exactly that so a nothing-consumed failed attempt cannot unprice a
priced fallback.

## 2. Lifecycle

```
reserve (by idempotency key) → work → commit | release
```

- **Reserve** holds estimated cost before the call. Estimates for model calls are priced
  at `maxOutputTokens` when pricing is known; a limit must exceed that estimate or the
  call is refused before the provider is touched.
- **Commit** settles against actual usage.
- **Release** frees the hold when work did not happen (policy deny, cancellation before
  start, …).

Reservations are **idempotent by key**: concurrent identical keys share one hold.
Semantics are covered by concurrent tests in the budget-engine package.

## 3. Windows

| Window      | Scope                                |
| ----------- | ------------------------------------ |
| `execution` | Per single execution                 |
| `total`     | Across calls against the same budget |

## 4. Failure class

Budget refusal uses failure class **`budget_blocked`** (not `budget_exhausted`). The
call is refused; nothing is partially charged.

## 5. Events

`ai.budget.reserved`, `ai.budget.committed`, `ai.budget.released`, `ai.budget.exceeded`.

## 6. Invariant

**Budget is checked before expensive work.** The architecture suite asserts the
dependency edge from orchestrator/tool-runtime/kernel to the budget engine.
