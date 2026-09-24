export type AiExecutionStatus =
  | "created" | "validated" | "authorized" | "reserved" | "planned"
  | "executing" | "settling" | "evaluating" | "completed"
  | "failed" | "cancelled" | "awaiting_approval";

export interface AiExecutionRequest<TInput = unknown> {
  requestId: string;
  tenantId: string;
  taskType: string;
  input: TInput;
  agentId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  deadlineAt?: string;
  modelRequirements?: ModelRequirements;
  budget?: BudgetLimit;
  metadata?: Record<string, string>;
}

export interface ModelRequirements {
  capabilities: string[];
  preferredModelIds?: string[];
  maxLatencyMs?: number;
  maxCost?: number;
}

export interface BudgetLimit { currency: string; maxAmount: number; }

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  latencyMs: number;
}

export interface AiExecutionResult<TOutput = unknown> {
  executionId: string;
  requestId: string;
  status: "completed" | "failed" | "cancelled" | "awaiting_approval";
  output?: TOutput;
  modelId?: string;
  providerId?: string;
  usage?: AiUsage;
  evaluation?: EvaluationResult;
  failure?: { code: string; message: string; retryable: boolean };
  approvalRequestId?: string;
}

export interface EvaluationResult {
  ruleSetId: string;
  ruleSetVersion: string;
  score: number;
  passed: boolean;
  evidence: string[];
}

export interface ModelDescriptor {
  id: string;
  providerId: string;
  version: string;
  capabilities: string[];
  qualityScore: number;
  costPer1kTokens: number;
  averageLatencyMs: number;
  enabled: boolean;
  metadata?: Record<string, string>;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  enabled: boolean;
}

export interface ModelInvocation {
  executionId: string;
  model: ModelDescriptor;
  input: unknown;
  signal: AbortSignal;
}

export interface ModelInvocationResult {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface ModelAdapter {
  invoke(invocation: ModelInvocation): Promise<ModelInvocationResult>;
}

export interface PolicyDecision {
  allowed: boolean;
  reasonCodes: string[];
  policyIds: string[];
}

export interface ToolDefinition {
  name: string;
  version: string;
  permissions: string[];
  maxConcurrency: number;
  invoke(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  executionId: string;
  tenantId: string;
  signal: AbortSignal;
}

export interface AiEvent {
  type: string;
  version: 1;
  eventId: string;
  executionId: string;
  requestId: string;
  correlationId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}
