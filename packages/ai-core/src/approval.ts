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
}

export class InMemoryApprovalGate implements ApprovalGate {
  constructor(private readonly taskTypes: Set<string> = new Set()) {}
  requiresApproval(request: AiExecutionRequest): boolean {
    return this.taskTypes.has(request.taskType);
  }
}
