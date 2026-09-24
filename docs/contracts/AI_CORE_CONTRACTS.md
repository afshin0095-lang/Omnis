# OMNIS AI Core Contracts

> Version: 1.0.0

## Principles

- Public interfaces are explicit TypeScript contracts.
- Provider-specific types remain inside adapters.
- Cross-package payloads are JSON-safe.
- Every execution carries correlation and idempotency metadata.
- Policy decisions and budget reservations occur before side effects.

## Canonical Request

interface AiExecutionRequest {
  requestId: string;
  tenantId: string;
  agentId?: string;
  taskType: string;
  input: unknown;
  constraints?: Record<string, unknown>;
  modelRequirements?: Record<string, unknown>;
  budget?: { currency: string; maxAmount: number };
  deadlineAt?: string;
  idempotencyKey?: string;
}

## Canonical Result

interface AiExecutionResult<T = unknown> {
  executionId: string;
  requestId: string;
  status: 'completed' | 'failed' | 'cancelled';
  output?: T;
  modelId?: string;
  providerId?: string;
  evaluation?: { score: number; passed: boolean };
  usage?: { inputTokens?: number; outputTokens?: number; estimatedCost?: number };
  failure?: { code: string; message: string; retryable: boolean };
}

## Policy Contract

A policy decision contains decision, reason codes, applicable policy IDs, evaluation timestamp and audit metadata.

## Budget Contract

A budget reservation is uniquely identified, bounded and transitions through reserved → settled/released without double settlement.

## Tool Contract

Tools declare name, version, input schema, output schema, permissions, concurrency limits and audit requirements.

## Evaluation Contract

Evaluations declare rule set/version, score, pass/fail outcome and evidence references.

## Event Contract

AI lifecycle events are versioned and contain execution ID, request ID, correlation ID, timestamp and actor/system metadata.
