import type { AiExecutionRequest, AiExecutionResult } from "./types.js";

export interface ExecutionRecord {
  executionId: string;
  request: AiExecutionRequest;
  result?: AiExecutionResult;
  state: string;
  updatedAt: string;
}

export interface ExecutionStore {
  save(record: ExecutionRecord): Promise<void>;
  get(executionId: string): Promise<ExecutionRecord | undefined>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();

  async save(record: ExecutionRecord): Promise<void> {
    this.records.set(record.executionId, { ...record, updatedAt: new Date().toISOString() });
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    const record = this.records.get(executionId);
    return record ? { ...record } : undefined;
  }
}
