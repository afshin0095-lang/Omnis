import { describe, expect, it } from "vitest";
import { createExecutionId } from "@omnis/types";
import { ExecutionScope } from "@omnis/execution-context";
import { collectingHooks, compositeHooks, NOOP_HOOKS, planIdOf } from "./ExecutionHooks.js";
import { stepEnvironment } from "./StepExecutor.js";
import type { ExecutionHooks, HookPoint, RetryDecision, StatusChange } from "./ExecutionHooks.js";
import { executionPlan, executionStep } from "./plans.js";
import { AT, AT_MS, attempt, executionRequest, record } from "./testSupport.js";

/** A hook set that appends a label at every point it observes. */
function tracingHooks(label: string, log: string[]): ExecutionHooks {
  return {
    beforeExecution: () => {
      log.push(`${label}:beforeExecution`);
    },
    afterExecution: () => {
      log.push(`${label}:afterExecution`);
    },
    beforeStep: () => {
      log.push(`${label}:beforeStep`);
    },
    afterStep: () => {
      log.push(`${label}:afterStep`);
    },
    onStatusChange: () => {
      log.push(`${label}:onStatusChange`);
    },
    onRetry: () => {
      log.push(`${label}:onRetry`);
    },
    onHookError: () => {
      log.push(`${label}:onHookError`);
    },
  };
}

/** One status change and one retry decision, for suites that need fixtures rather than a run. */
const CHANGE: StatusChange = Object.freeze({
  executionId: createExecutionId(),
  from: "validated",
  to: "authorized",
  at: AT,
  note: "policy allowed",
  stepId: null,
});
const RETRY: RetryDecision = Object.freeze({
  executionId: CHANGE.executionId,
  stepId: "step-1",
  attempt: 1,
  nextAttempt: 2,
  delayMs: 0,
  failureCode: "provider_failure",
  failureClass: "retryable",
});

describe("NOOP_HOOKS", () => {
  it("observes nothing and is frozen, so it can be shared", () => {
    expect(Object.isFrozen(NOOP_HOOKS)).toBe(true);
    expect(Object.keys(NOOP_HOOKS)).toEqual([]);
  });
});

describe("compositeHooks", () => {
  it("returns the noop set when given nothing to compose", () => {
    expect(compositeHooks()).toBe(NOOP_HOOKS);
    expect(compositeHooks(NOOP_HOOKS)).toBe(NOOP_HOOKS);
    expect(compositeHooks(NOOP_HOOKS, NOOP_HOOKS)).toBe(NOOP_HOOKS);
  });

  it("returns the single set unchanged, so identity survives composition", () => {
    const only = tracingHooks("only", []);
    expect(compositeHooks(only)).toBe(only);
    expect(compositeHooks(NOOP_HOOKS, only, NOOP_HOOKS)).toBe(only);
  });

  it("calls every hook set in the order given, at every point", async () => {
    const log: string[] = [];
    const composite = compositeHooks(tracingHooks("first", log), tracingHooks("second", log));
    const fixture = record();
    const step = executionStep();

    const scope = ExecutionScope.createRoot(
      { executionId: fixture.request.id },
      { clock: () => AT_MS },
    );
    await composite.beforeExecution?.(fixture);
    await composite.beforeStep?.(step, stepEnvironment(scope, step, 1, 1));
    await composite.afterStep?.(step, attempt());
    await composite.onStatusChange?.(CHANGE);
    await composite.onRetry?.(RETRY);
    await composite.onHookError?.("beforeStep", new Error("boom"), fixture.request.id);
    await composite.afterExecution?.(fixture);
    scope.dispose();

    expect(log).toEqual([
      "first:beforeExecution",
      "second:beforeExecution",
      "first:beforeStep",
      "second:beforeStep",
      "first:afterStep",
      "second:afterStep",
      "first:onStatusChange",
      "second:onStatusChange",
      "first:onRetry",
      "second:onRetry",
      "first:onHookError",
      "second:onHookError",
      "first:afterExecution",
      "second:afterExecution",
    ]);
  });

  it("waits for an asynchronous hook before calling the next one", async () => {
    const log: string[] = [];
    const slow: ExecutionHooks = {
      beforeExecution: async () => {
        await Promise.resolve();
        log.push("slow");
      },
    };
    const fast: ExecutionHooks = {
      beforeExecution: () => {
        log.push("fast");
      },
    };
    await compositeHooks(slow, fast).beforeExecution?.(record());
    expect(log).toEqual(["slow", "fast"]);
  });

  it("skips points a hook set does not implement", async () => {
    const log: string[] = [];
    const partial: ExecutionHooks = {
      afterStep: () => {
        log.push("partial");
      },
    };
    const composite = compositeHooks(partial, tracingHooks("full", log));
    await composite.afterStep?.(executionStep(), attempt());
    await composite.beforeExecution?.(record());
    expect(log).toEqual(["partial", "full:afterStep", "full:beforeExecution"]);
  });

  it("lets a throwing hook reach the caller, which is the kernel's job to contain", async () => {
    const broken: ExecutionHooks = {
      beforeExecution: () => {
        throw new Error("observer exploded");
      },
    };
    const composite = compositeHooks(broken, tracingHooks("after", []));
    await expect(composite.beforeExecution?.(record())).rejects.toThrowError(/observer exploded/);
  });

  it("is frozen, so a composed set cannot be edited after the run starts", () => {
    expect(Object.isFrozen(compositeHooks(tracingHooks("a", []), tracingHooks("b", [])))).toBe(
      true,
    );
  });
});

describe("collectingHooks", () => {
  it("collects every observation it is given", async () => {
    const hooks = collectingHooks();
    const fixture = record();
    await hooks.beforeExecution?.(fixture);
    await hooks.afterStep?.(
      executionStep({ id: "decode" }),
      attempt({ stepId: "decode", attempt: 2 }),
    );
    await hooks.onStatusChange?.(CHANGE);
    await hooks.onRetry?.(RETRY);
    await hooks.onHookError?.("afterStep", new Error("bad observer"), fixture.request.id);
    await hooks.afterExecution?.(fixture);

    expect(hooks.records).toHaveLength(2);
    expect(hooks.steps).toHaveLength(1);
    expect(hooks.steps[0]?.step.id).toBe("decode");
    expect(hooks.steps[0]?.attempt.attempt).toBe(2);
    expect(hooks.changes).toEqual([CHANGE]);
    expect(hooks.retries).toEqual([RETRY]);
    expect(hooks.hookErrors).toEqual([
      { point: "afterStep" as HookPoint, message: "bad observer" },
    ]);
  });

  it("stringifies a non-error hook failure rather than losing it", async () => {
    const hooks = collectingHooks();
    await hooks.onHookError?.("beforeStep", "just a string", null);
    expect(hooks.hookErrors[0]?.message).toBe("just a string");
  });

  it("stops growing at the configured limit, so a long run cannot exhaust memory", async () => {
    const hooks = collectingHooks(3);
    for (let index = 0; index < 10; index += 1) {
      await hooks.onStatusChange?.({ ...CHANGE, note: `move ${String(index)}` });
    }
    expect(hooks.changes).toHaveLength(3);
    expect(hooks.changes[0]?.note).toBe("move 0");
    expect(hooks.changes[2]?.note).toBe("move 2");
  });
});

describe("planIdOf", () => {
  it("returns null for a record that has not been planned yet", () => {
    expect(planIdOf(record())).toBeNull();
  });

  it("returns the plan identifier once a plan is attached", () => {
    const plan = executionPlan(
      { executionId: createExecutionId(), steps: [{ id: "only" }], createdAt: AT },
      () => AT_MS,
    );
    expect(planIdOf(record({ plan }))).toBe(plan.id);
  });
});

describe("hook inputs", () => {
  it("receives the record it observes, unmodified", async () => {
    const seen: unknown[] = [];
    const hooks: ExecutionHooks = {
      beforeExecution: (observed) => {
        seen.push(observed);
      },
    };
    const fixture = record({ request: executionRequest({ kind: "agent" }) });
    await hooks.beforeExecution?.(fixture);
    expect(seen[0]).toBe(fixture);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });
});
