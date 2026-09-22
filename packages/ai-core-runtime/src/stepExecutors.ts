/**
 * The bridge between an execution step and the runtimes that govern it.
 *
 * The kernel runs steps; it does not know what a model or a tool is. These two executors
 * are the only place a step becomes a call, and they deliberately do not make the call
 * themselves:
 *
 * - a `model` step becomes one {@link ModelOrchestrator} call, which re-runs policy and
 *   budget for that call, selects a provider, and falls back when one fails;
 * - a `tool` step becomes one {@link ToolRuntime} invocation, which re-checks
 *   permissions, policy and approval, and bounds the handler with a timeout.
 *
 * An executor that reached past those two — calling a provider adapter or a tool handler
 * directly because it already had one — would produce a step whose work was never gated.
 * That is the failure mode this file exists to prevent, and it is why neither the
 * provider registry nor the tool handlers are reachable from here.
 *
 * The step's input is the contract between an agent's plan and these executors:
 *
 * - `messages`: a conversation, when the plan carries one;
 * - `instructions`: the agent's system, developer and prohibition text, which the agent
 *   planner puts on every model step;
 * - `goal` and any other keys: the task, rendered as one user message;
 * - `arguments`: a tool step's arguments;
 * - `tool`: a tool step's name, when the step carries no resolved identifier.
 */

import {
  createExecutionFailure,
  EMPTY_USAGE,
  isGrantedApproval,
  messageText,
  modelById,
  textMessage,
  toolById,
  toolByName,
} from "@omnis/ai-core-types";
import type {
  Message,
  ModelResponse,
  PolicyId,
  ToolId,
  ToolResult,
  UsageSummary,
} from "@omnis/ai-core-types";
import type { JsonObject, JsonValue } from "@omnis/types";
import { failedOutcome, stepExecutor, succeededOutcome } from "@omnis/execution-kernel";
import type { StepEnvironment, StepExecutor, StepOutcome } from "@omnis/execution-kernel";
import type {
  ModelCallRequest,
  ModelCallResult,
  ModelOrchestrator,
} from "@omnis/model-orchestrator";
import type { ToolInvocationRequest, ToolRuntime } from "@omnis/tool-runtime";
import type { ExecutionStep } from "@omnis/ai-core-types";

/** The most user-message text one step may carry. */
export const MAX_STEP_MESSAGE_TEXT = 32_768;

/** Keys in a step's input that describe the call rather than the task. */
const RESERVED_INPUT_KEYS: ReadonlySet<string> = new Set([
  "goal",
  "instructions",
  "messages",
  "policyIds",
  "arguments",
]);

/** What a model step's input may carry. */
interface ModelStepInput {
  readonly messages?: unknown;
  readonly instructions?: unknown;
  readonly goal?: unknown;
}

/** The agent instructions a planner puts on a model step. */
interface StepInstructions {
  readonly system: string | null;
  readonly developer: string | null;
  readonly prohibitions: readonly string[];
}

/** Reads a string field, or `null` when the input does not carry one. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads the instructions a planner attached, tolerating a step that carries none. */
function instructionsOf(input: ModelStepInput): StepInstructions | null {
  const raw = input.instructions;
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const system = text(candidate["system"]);
  const developer = text(candidate["developer"]);
  const prohibitions = Array.isArray(candidate["prohibitions"])
    ? candidate["prohibitions"].filter((entry): entry is string => typeof entry === "string")
    : [];
  if (system === null && developer === null && prohibitions.length === 0) {
    return null;
  }
  return { system, developer, prohibitions };
}

/**
 * True when a value is structurally a message.
 *
 * A step's input has already been through JSON-safe validation, but not through the
 * message contract: the plan carries data, and the message schema belongs to the
 * orchestrator's caller. Checking the shape here means a malformed conversation is
 * reported as a validation failure on the step that carried it, rather than surfacing as
 * a provider error two layers down.
 */
function isMessageValue(value: unknown): value is Message {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["role"] !== "string" || !Array.isArray(candidate["content"])) {
    return false;
  }
  return candidate["content"].every(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      typeof (part as Record<string, unknown>)["type"] === "string",
  );
}

/** The conversation a model step carries, or the one its goal implies. */
export function messagesForStep(step: ExecutionStep): readonly Message[] {
  const input = step.input as ModelStepInput;
  const supplied = Array.isArray(input.messages) ? input.messages.filter(isMessageValue) : [];
  if (supplied.length > 0) {
    return Object.freeze(supplied);
  }

  const messages: Message[] = [];
  const instructions = instructionsOf(input);
  if (instructions?.system !== null && instructions?.system !== undefined) {
    messages.push(textMessage("system", instructions.system));
  }
  if (instructions?.developer !== null && instructions?.developer !== undefined) {
    messages.push(textMessage("developer", instructions.developer));
  }

  const goal = text(input.goal);
  // Platform bookkeeping stays out of the prompt: `policyIds` describes who may govern this
  // call and `arguments` belongs to a tool, and sending either to a provider would leak the
  // composition's internals into somebody else's context window.
  const facts = Object.entries(step.input)
    .filter(([key]) => !RESERVED_INPUT_KEYS.has(key))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  const prompt = [goal, facts.length > 0 ? facts : null]
    .filter((part): part is string => part !== null)
    .join("\n\n");
  if (instructions !== null && instructions.prohibitions.length > 0) {
    messages.push(textMessage("system", `Never: ${instructions.prohibitions.join("; ")}`));
  }
  if (prompt.length > 0) {
    messages.push(textMessage("user", prompt.slice(0, MAX_STEP_MESSAGE_TEXT)));
  }
  if (messages.length === 0) {
    // An empty conversation is not something to send: the orchestrator would refuse it, and
    // refusing it here says which step carried nothing.
    messages.push(textMessage("user", `complete the step "${step.name}"`));
  }
  return Object.freeze(messages);
}

/** The JSON-safe rendering of a model response, which is what the next step can read. */
export function modelStepOutput(response: ModelResponse): JsonObject {
  return {
    text: messageText(response.message),
    stopReason: response.stopReason,
    streamed: response.streamed,
    modelId: String(response.modelId),
    providerId: String(response.providerId),
    toolCalls: response.message.content.flatMap((part) =>
      part.type === "tool_call"
        ? [
            {
              callId: part.call.callId,
              name: part.call.name,
              arguments: part.call.arguments satisfies JsonValue,
            },
          ]
        : [],
    ),
  };
}

/** What a model executor needs: the orchestrator, and nothing else. */
export interface ModelStepExecutorOptions {
  readonly orchestrator: ModelOrchestrator;
  /** Policy sets every model step is gated by, in addition to the step's own. */
  readonly defaultPolicyIds?: readonly string[];
}

/**
 * Builds the executor that runs `model` steps.
 *
 * A step with no resolved model is a failed step rather than an improvised call: choosing
 * a model the plan did not name would make the audit row describe work nobody asked for.
 */
export function modelStepExecutor(options: ModelStepExecutorOptions): StepExecutor {
  return stepExecutor(
    "model",
    async (step: ExecutionStep, environment: StepEnvironment): Promise<StepOutcome> => {
      if (step.modelId === null) {
        return failedOutcome(
          createExecutionFailure({
            class: "validation",
            code: "validation_failed",
            message: `the model step "${step.id}" names no model, and the runtime will not choose one for it`,
            retryable: false,
            stepId: step.id,
            executionId: environment.executionId,
          }),
        );
      }

      const request: ModelCallRequest = {
        model: modelById(step.modelId),
        messages: messagesForStep(step),
        executionId: environment.executionId,
        correlationId: environment.correlationId,
        tenantId: environment.tenantId,
        agentId: environment.context.agentId,
        // An approval granted for the execution travels with the call it authorizes. Without
        // this, a human approving a run would watch it fail at the first gated model call.
        approval: isGrantedApproval(environment.approval) ? environment.approval : null,
        policyIds: [...(options.defaultPolicyIds ?? []), ...policyIdsOf(step)],
        deadlineMs: environment.remainingMs(),
        timeoutMs: step.timeoutMs,
        metadata: step.metadata,
      };

      const result: ModelCallResult = await options.orchestrator.call(request, environment.context);
      return result.status === "succeeded"
        ? succeededOutcome(modelStepOutput(result.response), result.usage, {
            modelId: String(result.modelId),
            providerId: String(result.providerId),
            latencyMs: result.latencyMs,
            fallbacks: result.fallbacks,
          })
        : failedOutcome(result.failure, result.usage, {
            ...(result.modelId === null ? {} : { modelId: String(result.modelId) }),
            ...(result.providerId === null ? {} : { providerId: String(result.providerId) }),
            fallbacks: result.fallbacks,
          });
    },
  );
}

/**
 * What a tool step consumed: nothing that a model budget measures.
 *
 * The cost is zero rather than `EMPTY_USAGE`'s `null` on purpose. `null` means
 * "unpriced", and an unpriced step makes every total it is folded into unpriced too —
 * so one tool step in a plan would hide the cost of the model calls around it, and an
 * agent's cost ceiling would have nothing to compare against. A tool call in Sprint 1
 * has no price, which is a fact worth recording as zero, not an absence of fact.
 */
const TOOL_STEP_USAGE: UsageSummary = Object.freeze({ ...EMPTY_USAGE, costMicro: 0 });

/** The policy sets a step's own input names, when a plan carries any. */
function policyIdsOf(step: ExecutionStep): readonly string[] {
  const declared = (step.input as { policyIds?: unknown }).policyIds;
  if (!Array.isArray(declared)) {
    return [];
  }
  return declared.filter((entry): entry is string => typeof entry === "string");
}

/** What a tool executor needs: the tool runtime, and nothing else. */
export interface ToolStepExecutorOptions {
  readonly runtime: ToolRuntime;
  readonly defaultPolicyIds?: readonly PolicyId[];
}

/** The identifier a tool step resolves to, or `null` when it names nothing registered. */
function toolIdFor(step: ExecutionStep, runtime: ToolRuntime): ToolId | null {
  if (step.toolId !== null) {
    return step.toolId;
  }
  const named = (step.input as { tool?: unknown }).tool;
  if (typeof named !== "string") {
    return null;
  }
  return runtime.registry.resolve(toolByName(named))?.id ?? null;
}

/** The arguments a tool step carries. */
export function argumentsForStep(step: ExecutionStep): Readonly<Record<string, JsonValue>> {
  const declared = (step.input as { arguments?: unknown }).arguments;
  if (declared !== null && typeof declared === "object" && !Array.isArray(declared)) {
    return declared as Readonly<Record<string, JsonValue>>;
  }
  // A step with no `arguments` key passes the rest of its input, minus the plan's own
  // bookkeeping: a tool step whose input *is* the argument bag is the common case, and
  // demanding a nested key would make every plan say the same thing twice.
  const {
    arguments: _ignoredArguments,
    goal: _ignoredGoal,
    instructions: _ignoredInstructions,
    tool: _ignoredTool,
    ...rest
  } = step.input;
  return rest;
}

/**
 * Builds the executor that runs `tool` steps.
 *
 * A denial is reported as a failed step with the denial's own reason, not as a thrown
 * error: the tool runtime already decided, and its decision is the fact worth recording.
 */
export function toolStepExecutor(options: ToolStepExecutorOptions): StepExecutor {
  return stepExecutor(
    "tool",
    async (step: ExecutionStep, environment: StepEnvironment): Promise<StepOutcome> => {
      const toolId = toolIdFor(step, options.runtime);
      if (toolId === null) {
        return failedOutcome(
          createExecutionFailure({
            class: "validation",
            code: "validation_failed",
            message: `the tool step "${step.id}" names no registered tool`,
            retryable: false,
            stepId: step.id,
            executionId: environment.executionId,
            toolId: step.toolId,
          }),
        );
      }

      const request: ToolInvocationRequest = {
        tool: toolById(toolId),
        arguments: argumentsForStep(step),
        context: environment.context,
        attempt: environment.attempt,
        timeoutMs: step.timeoutMs,
        // The tool runtime wants to know *who* approved, so an approval with no recorded
        // approver is not forwarded: inventing a name would put somebody else in the audit row.
        approval:
          isGrantedApproval(environment.approval) && environment.approval.approver !== null
            ? {
                approved: true,
                approver: environment.approval.approver,
                approvedAt: environment.approval.approvedAt,
              }
            : null,
        policyIds: options.defaultPolicyIds ?? [],
        metadata: step.metadata,
      };

      const result: ToolResult = await options.runtime.invoke(request);
      if (result.status === "succeeded") {
        return succeededOutcome(result.value, TOOL_STEP_USAGE, {
          toolId: String(result.toolId),
          durationMs: result.durationMs,
        });
      }
      if (result.status === "denied") {
        return failedOutcome(
          createExecutionFailure({
            class:
              result.reason === "policy" || result.reason === "approval_required"
                ? "policy_blocked"
                : "non_retryable",
            code: "policy_violation",
            message: `the tool step "${step.id}" was denied: ${result.message}`,
            retryable: false,
            stepId: step.id,
            executionId: environment.executionId,
            toolId,
            details: { denial: result.reason },
          }),
          TOOL_STEP_USAGE,
          { toolId: String(toolId), denial: result.reason },
        );
      }
      return failedOutcome(
        createExecutionFailure({
          class: result.cancelled
            ? "cancelled"
            : result.timedOut
              ? "deadline_exceeded"
              : "tool_failure",
          // A tool reports its own error code, which is not a platform code: the platform code
          // says what kind of failure this was, and the tool's own goes in the details where a
          // consumer can read it without guessing which vocabulary it is in.
          // There is no cancellation code: `class: "cancelled"` is the platform's word for it,
          // and inventing a code for one failure kind would fork the vocabulary.
          code: result.timedOut ? "timeout" : "execution_failed",
          message: result.message,
          retryable: result.retryable,
          stepId: step.id,
          executionId: environment.executionId,
          toolId,
          details: {
            toolErrorCode: result.errorCode,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
          },
        }),
        TOOL_STEP_USAGE,
        { toolId: String(toolId), durationMs: result.durationMs },
      );
    },
  );
}
