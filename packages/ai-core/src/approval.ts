import { randomUUID } from "node:crypto";
import type { AiExecutionRequest } from "./types.js";

export interface ApprovalRequest {
  id: string;
  executionId: string;
  requestedBy: string;
  reason: string;
  createdAt: string;
  expiresAt?: string;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  decidedAt: string;
  reason?: string;
}

export interface ApprovalGate {
  requiresApproval(request: AiExecutionRequest): boolean;
  createRequest(executionId: string, request: AiExecutionRequest): ApprovalRequest;
}

export class InMemoryApprovalGate implements ApprovalGate {
  constructor(private readonly taskTypes: Set<string> = new Set()) {}
  requiresApproval(request: AiExecutionRequest): boolean { return this.taskTypes.has(request.taskType); }
  createRequest(executionId: string, request: AiExecutionRequest): ApprovalRequest {
    return {
      id: randomUUID(), executionId, requestedBy: request.agentId ?? "system",
      reason: "TASK_REQUIRES_HUMAN_APPROVAL", createdAt: new Date().toISOString(),
    };
  }
}
