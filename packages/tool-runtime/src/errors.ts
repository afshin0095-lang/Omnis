/**
 * Tool runtime errors.
 *
 * The runtime distinguishes sharply between *refusing to run a tool* and *a tool that ran and
 * failed*. Refusals are errors thrown at the caller — the invocation never started, so there is
 * nothing to normalize. Failures inside an invocation are **not** thrown: they come back as a
 * {@link ToolResult} with `status: "failed"`, because an agent has to see the failure as data it
 * can react to, and a thrown error would unwind the execution instead.
 *
 * The one exception is a denial, which is also returned as a result rather than thrown: the
 * contract's `denied` variant exists so a policy refusal reaches the model in the same shape as
 * any other outcome.
 */

import { ConflictError, NotFoundError, ValidationError } from "@omnis/errors";
import type { ToolDenialReason, ToolId, ToolReference, ToolStatus } from "@omnis/ai-core-types";

/** A tool that is not registered. */
export function toolNotRegistered(reference: ToolReference): NotFoundError {
  const described = reference.kind === "id" ? reference.toolId : `name "${reference.name}"`;
  return new NotFoundError("tool", described, {
    retryable: false,
    metadata: { registry: "tool", kind: reference.kind },
  });
}

/** A tool name or identifier that is already registered. */
export function duplicateTool(key: string, existingToolId: ToolId): ConflictError {
  return new ConflictError(`tool:${key}`, `tool "${key}" is already registered`, {
    retryable: false,
    metadata: { key, existingToolId, registry: "tool" },
  });
}

/** A tool definition the runtime cannot safely invoke. */
export function invalidToolDescriptor(reason: string, name: string | null = null): ValidationError {
  return new ValidationError(`tool descriptor is invalid: ${reason}`, {
    retryable: false,
    metadata: { name, registry: "tool" },
  });
}

/** A handler that does not satisfy the tool contract. */
export function invalidToolHandler(name: string, reason: string): ValidationError {
  return new ValidationError(`tool handler for "${name}" is invalid: ${reason}`, {
    retryable: false,
    metadata: { name },
  });
}

/** Arguments that do not satisfy the tool's declared parameter schema. */
export function invalidToolArguments(name: string, problems: readonly string[]): ValidationError {
  return new ValidationError(`arguments for tool "${name}" are invalid: ${problems.join("; ")}`, {
    retryable: false,
    // Argument *values* are never attached: they routinely carry credentials and personal data.
    metadata: { name, problems, argumentCount: problems.length },
  });
}

/** A tool status transition the registry does not allow. */
export function invalidToolStatusTransition(
  name: string,
  from: ToolStatus,
  to: ToolStatus,
): ValidationError {
  return new ValidationError(`tool "${name}" cannot move from ${from} to ${to}`, {
    retryable: false,
    metadata: { name, from, to },
  });
}

/** Too many tools for the configured capacity. */
export function toolRegistryCapacityExceeded(capacity: number): ConflictError {
  return new ConflictError(
    "tool-registry-capacity",
    `tool registry is full at ${String(capacity)} tools`,
    {
      retryable: false,
      metadata: { capacity },
    },
  );
}

/** The message a denial result carries. Stable, so callers can branch on the reason instead. */
export function denialMessage(reason: ToolDenialReason, name: string, detail: string): string {
  switch (reason) {
    case "unregistered":
      return `tool "${name}" is not registered`;
    case "permission":
      return `tool "${name}" requires permissions that were not granted: ${detail}`;
    case "policy":
      return `policy refused tool "${name}": ${detail}`;
    case "approval_required":
      return `tool "${name}" requires approval before it may run: ${detail}`;
    case "disabled":
      return `tool "${name}" is ${detail} and cannot be invoked`;
    case "concurrency":
      return `tool "${name}" is at its concurrency limit: ${detail}`;
  }
}
