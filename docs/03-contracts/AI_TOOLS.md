# AI Tools

Status: Accepted · Owner: `@omnis/tool-runtime` · Sprint: 1

How tools are described, authorised and invoked.

## 1. Descriptor

A `ToolDescriptor` carries name, display name, description, version, kind, risk level,
side effect, permissions, JSON-schema parameters, result description, timeout,
cancellation support, max concurrency, approval requirement, optional policy/budget
bindings and status.

Risk levels map to operator tones in Studio (`low` → positive/neutral, `medium` →
caution, `high`/`critical` → negative). A critical irreversible tool should require
approval; the mock catalogue demonstrates that pairing.

## 2. Invocation path

```
request → permission check → policy gate → budget hold → handler (with timeout race)
        → result normalisation → settle budget → telemetry → audit
```

| Gate          | Failure class                                            |
| ------------- | -------------------------------------------------------- |
| Unknown tool  | throws `NotFoundError`                                   |
| Bad arguments | `failed` / `tool_arguments_invalid` (handler not called) |
| Policy deny   | `policy_blocked`                                         |
| Budget refuse | `budget_blocked`                                         |
| Timeout       | `deadline_exceeded` + `timeout`                          |
| Cancellation  | `cancelled` + `execution_failed`                         |

Timeout uses `Promise.race` and **clears the timer** when the handler wins, so a
resolved invocation does not leave a dangling timer.

## 3. Results

A `ToolResult` is normalised: success carries value and duration; denial has no
duration. Cost for tool steps should report `0` micro-USD (not `null`) when the tool
is unpriced, so a mixed agent plan does not lose its total cost to a null fold.

## 4. What tools never do

- Import a vendor AI SDK
- Bypass policy or budget
- Run without a declared timeout ceiling when one is configured
- Log raw arguments that may contain secrets (redaction applies)
