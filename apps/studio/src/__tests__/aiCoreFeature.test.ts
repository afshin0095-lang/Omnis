/**
 * The AI Core feature: client, view models and the mock that stands in for a backend.
 *
 * These tests run the client against the mock, which is the pairing the app itself uses in
 * development, so what is asserted here is what a screen will actually receive. Two things
 * get the most attention, because they are the two that fail silently:
 *
 * - **mapping**: a payload whose shape changed must produce a named failure rather than a
 *   column of blanks;
 * - **honesty**: a simulated run must say it is simulated, a cost nobody priced must not
 *   read as free, and a refusal must arrive as a value a screen can render.
 */

import { describe, expect, it } from "vitest";
import {
  createAiCoreClient,
  createMockAiCoreRuntime,
  formatMicroUsd,
  statusTone,
  viewErrorOf,
} from "../features/ai-core";
import type { AiCoreResult, AiCoreTransport } from "../features/ai-core";
import { ValidationError } from "@omnis/errors";

/** A client over a fresh mock, which is how the app wires it in development. */
function fixture(options: Parameters<typeof createMockAiCoreRuntime>[0] = {}) {
  const mock = createMockAiCoreRuntime(options);
  return { mock, client: createAiCoreClient(mock) };
}

/** Unwraps a result, failing the test with the error's own message if there is one. */
function valueOf<TValue>(result: AiCoreResult<TValue>): TValue {
  if (!result.ok) {
    expect.unreachable(`the call failed: ${result.error.message}`);
  }
  return result.value;
}

describe("health", () => {
  it("reports the catalog and derives whether the platform can do its job", async () => {
    const { client } = fixture();
    const health = valueOf(await client.health());

    expect(health).toMatchObject({ models: 3, providers: 2, tools: 2, agents: 1, executions: 0 });
    expect(health.ready).toBe(true);
    expect(health.canCallModels).toBe(true);
  });

  it("counts the executions it has recorded", async () => {
    const { client } = fixture();
    await client.runAgent({ slug: "researcher", goal: "summarize the quarter" });
    const health = valueOf(await client.health());

    expect(health.executions).toBe(1);
  });
});

describe("the catalog", () => {
  it("maps models, and says which of them nobody has priced", async () => {
    const { client } = fixture();
    const models = valueOf(await client.listModels());

    expect(models.map((model) => model.slug)).toEqual([
      "aurora-class",
      "aurora-vision",
      "meridian-class",
    ]);
    const unpriced = models.find((model) => model.slug === "aurora-vision");
    // A cost column that has never seen an unpriced model shows $0.00 for it, and $0.00 is
    // a claim about money rather than an admission that nobody knows.
    expect(unpriced?.priced).toBe(false);
    expect(models.find((model) => model.slug === "aurora-class")?.priced).toBe(true);
    expect(models.every((model) => model.tone === "positive")).toBe(true);
  });

  it("maps providers with their health, and never with a credential", async () => {
    const { client, mock } = fixture();
    const providers = valueOf(await client.listProviders());

    expect(providers.map((provider) => [provider.slug, provider.status, provider.tone])).toEqual([
      ["aurora", "ready", "positive"],
      ["meridian", "degraded", "caution"],
    ]);
    expect(providers[1]?.health).toMatchObject({ state: "degraded", consecutiveFailures: 2 });
    // Whether credentials exist is an operator fact; what they are is not this layer's
    // business, and a payload that carried them would carry them to every screen.
    expect(providers.every((provider) => provider.credentialsConfigured)).toBe(true);
    expect(JSON.stringify(await mock.request("providers.list", {}))).not.toMatch(
      /sk-|apikey|secret/i,
    );
  });

  it("maps an agent's ceilings into labelled rows, skipping the ones it never set", async () => {
    const { client } = fixture();
    const agents = valueOf(await client.listAgents());
    const agent = agents[0];

    expect(agent?.slug).toBe("researcher");
    expect(agent?.defaultModel).toBe("capability:chat");
    const constraints = agent?.constraints ?? [];
    expect(constraints.map((constraint) => constraint.kind)).toContain("max_cost_micro_usd");
    expect(
      constraints.find((constraint) => constraint.kind === "max_cost_micro_usd"),
    ).toMatchObject({
      label: "Spend limit",
      limit: 25_000,
      limitLabel: "$0.025000",
    });
    // An agent with no ceiling on a dimension gets no row for it: six "no limit" rows would
    // bury the two an operator actually set.
    expect(constraints.every((constraint) => constraint.limit !== null)).toBe(true);
  });

  it("maps tools, with risk as a tone and approval as a fact", async () => {
    const { client } = fixture();
    const tools = valueOf(await client.listTools());

    expect(tools.map((tool) => [tool.name, tool.riskLevel, tool.tone])).toEqual([
      ["web-search", "medium", "caution"],
      ["publish-post", "critical", "negative"],
    ]);
    expect(tools[1]?.requiresApproval).toBe(true);
    expect(tools[0]?.parameterNames).toEqual(["query", "maxResults"]);
  });
});

describe("running an agent", () => {
  it("returns a run, and the execution list can then show it", async () => {
    const { client } = fixture();
    const run = valueOf(
      await client.runAgent({ slug: "researcher", goal: "summarize the quarter" }),
    );

    expect(run.succeeded).toBe(true);
    expect(run.agentSlug).toBe("researcher");
    expect(run.state).toBe("completed");
    expect(run.usage).toMatchObject({
      totalTokens: 1_060,
      costMicroUsd: 1_850,
      costLabel: "$0.001850",
    });
    expect(run.execution.status).toBe("succeeded");
    expect(run.execution.terminal).toBe(true);
    expect(run.execution.durationMs).toBe(542);

    const executions = valueOf(await client.listExecutions());
    expect(executions).toHaveLength(1);
    expect(executions[0]?.id).toBe(run.execution.id);
    expect(executions[0]?.subject).toContain("agent");
  });

  it("says plainly that the answer is simulated", async () => {
    const { client } = fixture();
    const run = valueOf(
      await client.runAgent({ slug: "researcher", goal: "summarize the quarter" }),
    );

    // The one thing a mock must never do is look like the real thing. A screen that renders
    // this output during development shows text that claims to be a model's answer.
    expect(run.output).toMatchObject({ simulated: true, stepsCompleted: 2 });
  });

  it("derives each step's status from its attempts, including what it depends on", async () => {
    const { client } = fixture();
    const run = valueOf(
      await client.runAgent({ slug: "researcher", goal: "summarize the quarter" }),
    );
    const steps = run.execution.steps;

    expect(steps.map((step) => [step.id, step.kind, step.status])).toEqual([
      ["research", "tool", "succeeded"],
      ["draft", "model", "succeeded"],
    ]);
    expect(steps[1]?.dependsOn).toEqual(["research"]);
    expect(steps[1]?.durationMs).toBe(480);
  });

  it("carries the evaluation, and says it was decided by rules", async () => {
    const { client } = fixture();
    const run = valueOf(
      await client.runAgent({ slug: "researcher", goal: "summarize the quarter" }),
    );
    const evaluation = run.execution.evaluation;

    expect(evaluation).toMatchObject({ verdict: "pass", overallScore: 0.94, deterministic: true });
    expect(evaluation?.scores.map((score) => score.dimension)).toEqual(["grounding", "format"]);
  });

  it("returns a refusal as a value, not as an exception", async () => {
    const { client } = fixture({ runOutcome: "policy_denied" });
    const result = await client.runAgent({ slug: "researcher", goal: "publish without review" });

    // A screen has to render this. If it arrived as a rejection, the component that forgot
    // a `try` would show an empty panel and the operator would retry it forever.
    expect(result.ok).toBe(true);
    const run = valueOf(result);
    expect(run.succeeded).toBe(false);
    expect(run.failure).toMatchObject({
      kind: "policy_blocked",
      code: "policy_violation",
      tone: "negative",
    });
    expect(run.failure?.retryable).toBe(false);
    expect(run.execution.attempts).toHaveLength(0);
  });

  it("runs an empty goal into a validation error, the way the platform would", async () => {
    const { client } = fixture();
    const result = await client.runAgent({ slug: "researcher", goal: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        kind: "validation",
        code: "validation_failed",
        retryable: false,
      });
    }
  });
});

describe("approvals", () => {
  it("waits, and continues as a second attempt once an operator approves", async () => {
    const { client } = fixture({ runOutcome: "requires_approval" });
    const waiting = valueOf(
      await client.runAgent({ slug: "researcher", goal: "publish the post" }),
    );

    expect(waiting.succeeded).toBe(false);
    expect(waiting.state).toBe("waiting");
    expect(waiting.waitingOn).toBe("approval");

    const approved = valueOf(
      await client.approveExecution(waiting.execution.id, { approved: true, approver: "ops" }),
    );
    expect(approved.succeeded).toBe(true);
    // The approval is a second execution of one decision, not a rewrite of the first: an
    // audit reader has to see that a human was asked, and what they said.
    expect(approved.attempt).toBe(2);
  });

  it("refuses to approve an execution that was never waiting", async () => {
    const { client } = fixture();
    const run = valueOf(
      await client.runAgent({ slug: "researcher", goal: "summarize the quarter" }),
    );
    const result = await client.approveExecution(run.execution.id, {
      approved: true,
      approver: "ops",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.message).toContain("not waiting");
    }
  });
});

describe("cancellation and lookup", () => {
  it("refuses to cancel an execution that already finished", async () => {
    const { client } = fixture();
    const run = valueOf(
      await client.runAgent({ slug: "researcher", goal: "summarize the quarter" }),
    );
    const result = await client.cancelExecution(run.execution.id, "the operator stopped it");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.message).toContain("already finished");
    }
  });

  it("reports a missing execution as missing, with the identifier in the message", async () => {
    const { client } = fixture();
    const result = await client.getExecution("exe_NOTHING_LIKE_THIS");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        kind: "not_found",
        code: "not_found",
        retryable: false,
      });
      expect(result.error.message).toContain("exe_NOTHING_LIKE_THIS");
    }
  });

  it("lists nothing before anything has run", async () => {
    const { client } = fixture();
    expect(valueOf(await client.listExecutions())).toHaveLength(0);
  });
});

describe("a payload that does not have the shape the client expects", () => {
  it("names the field that was wrong instead of rendering a blank", async () => {
    // A backend that renames `displayName` is the ordinary case: a deploy on one side and
    // not the other. The failure has to say which field, or the screen shows an empty card
    // and somebody spends an afternoon finding out why.
    const broken: AiCoreTransport = {
      request: async () => ({ models: [{ id: "mdl_x", slug: "x" }] }),
    };
    const result = await createAiCoreClient(broken).listModels();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      // The path is the useful part: it says which entry of which list was wrong.
      expect(result.error.message).toContain("models[0]");
    }
  });

  it("treats a payload that is not even an object as malformed", async () => {
    const broken: AiCoreTransport = { request: async () => "no" };
    const result = await createAiCoreClient(broken).health();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("reports an error it does not recognize as unknown, with its own text", async () => {
    const broken: AiCoreTransport = {
      request: async () => {
        throw new TypeError("the transport was never configured");
      },
    };
    const result = await createAiCoreClient(broken).health();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        kind: "unknown",
        code: null,
        retryable: false,
        message: "the transport was never configured",
      });
    }
  });
});

describe("view helpers", () => {
  it("renders money, and keeps an unpriced cost distinct from a free one", () => {
    expect(formatMicroUsd(null)).toBe("not priced");
    expect(formatMicroUsd(0)).toBe("$0.000000");
    expect(formatMicroUsd(1_850)).toBe("$0.001850");
    expect(formatMicroUsd(2_500_000)).toBe("$2.50");
  });

  it("renders a status it has never seen as neutral rather than as a problem", () => {
    expect(statusTone("succeeded")).toBe("positive");
    expect(statusTone("degraded")).toBe("caution");
    expect(statusTone("policy_blocked")).toBe("negative");
    // A new status is the platform growing, not something breaking. Painting it red would
    // teach operators to ignore red.
    expect(statusTone("quarantined")).toBe("neutral");
  });

  it("maps the platform's error codes onto what a screen should do", () => {
    expect(viewErrorOf(new ValidationError("that is not a goal")).kind).toBe("validation");
    expect(viewErrorOf("a string somebody threw").kind).toBe("unknown");
  });
});

describe("determinism", () => {
  it("produces equal payloads for equal operations", async () => {
    const first = createMockAiCoreRuntime();
    const second = createMockAiCoreRuntime();
    await first.request("agents.run", { slug: "researcher", goal: "summarize the quarter" });
    await second.request("agents.run", { slug: "researcher", goal: "summarize the quarter" });

    // Fixed identifiers and a fixed clock are what make a screenshot of this surface mean
    // something, and what let the assertions above name an exact cost.
    expect(await first.request("executions.list", {})).toEqual(
      await second.request("executions.list", {}),
    );
    expect(await first.request("models.list", {})).toEqual(await second.request("models.list", {}));
  });

  it("forgets its executions when reset, and starts numbering again", async () => {
    const mock = createMockAiCoreRuntime();
    await mock.request("agents.run", { slug: "researcher", goal: "first" });
    mock.reset();

    expect(mock.executions).toHaveLength(0);
    await mock.request("agents.run", { slug: "researcher", goal: "second" });
    expect(String((mock.executions[0]?.request as { id: string }).id)).toContain("exe_");
  });
});
