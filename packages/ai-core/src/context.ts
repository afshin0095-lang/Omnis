import type { AiExecutionRequest } from "./types.js";

export interface ExecutionContext {
  executionId: string;
  request: AiExecutionRequest;
  correlationId: string;
  startedAt: string;
  signal: AbortSignal;
}

export function createExecutionContext(
  request: AiExecutionRequest,
  executionId: string,
  controller: AbortController,
): ExecutionContext {
  return {
    executionId,
    request,
    correlationId: request.correlationId ?? request.requestId,
    startedAt: new Date().toISOString(),
    signal: controller.signal,
  };
}

export function assertDeadline(ctx: ExecutionContext): void {
  if (ctx.request.deadlineAt && Date.now() >= Date.parse(ctx.request.deadlineAt)) {
    throw new Error("EXECUTION_DEADLINE_EXCEEDED");
  }
  if (ctx.signal.aborted) throw new Error("EXECUTION_CANCELLED");
}
