# AI Evaluation

Status: Accepted · Owner: `@omnis/ai-evaluation` · Sprint: 1

How an execution result is scored after it finishes.

## 1. Deterministic rules only

Sprint 1 evaluation is **rule-based**. There is no LLM-as-judge, no provider call, and
no non-deterministic sampling. `EvaluationResult.deterministic` is always `true` for
results produced by this package.

## 2. Result shape

| Field           | Meaning                              |
| --------------- | ------------------------------------ |
| `id`            | Branded evaluation id (`evl_…`)      |
| `executionId`   | The execution that was scored        |
| `verdict`       | e.g. `pass` / `fail` / `review`      |
| `overallScore`  | Weighted aggregate in `[0, 1]`       |
| `scores`        | Per-dimension `EvaluationScore` rows |
| `rulesApplied`  | Which rules fired                    |
| `evaluatedAt`   | Timestamp                            |
| `deterministic` | `true`                               |
| `metadata`      | JSON-safe bag                        |

Each score carries dimension, score, verdict, weight and findings.

## 3. Placement in the pipeline

Evaluation runs **after** the kernel finishes a successful (or partially successful)
execution and **before** the run is fully settled for reporting. A failing evaluation
does not rewrite history; it attaches to the record.

## 4. Events

`ai.evaluation.completed` carries the result summary without embedding full model
outputs when those may contain sensitive content.

## 5. What it does not do

- Call a model
- Mutate the execution record's attempts
- Override a policy or budget decision
- Produce non-deterministic scores
