import type { AiExecutionRequest, AiExecutionResult, AiExecutionStatus } from "./types.js";

export interface ExecutionRecord {
  executionId: string;
  request: AiExecutionRequest;
  result?: AiExecutionResult;
  state: AiExecutionStatus;
  idempotencyKey?: string;
  updatedAt: string;
}

export interface ExecutionStore {
  save(record: ExecutionRecord): Promise<void>;
  get(executionId: string): Promise<ExecutionRecord | undefined>;
  findByIdempotencyKey(tenantId: string, key: string): Promise<ExecutionRecord | undefined>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly idempotency = new Map<string, string>();

  async save(record: ExecutionRecord): Promise<void> {
    this.records.set(record.executionId, { ...record, updatedAt: new Date().toISOString() });
    if (record.idempotencyKey) this.idempotency.set(this.key(record.request.tenantId, record.idempotencyKey), record.executionId);
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    const record = this.records.get(executionId);
    return record ? { ...record } : undefined;
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<ExecutionRecord | undefined> {
    const executionId = this.idempotency.get(this.key(tenantId, key));
    return executionId ? this.get(executionId) : undefined;
  }

  private key(tenantId: string, idempotencyKey: string): string {
    return tenantId + ":" + idempotencyKey;
  }
}
