import type { AiExecutionRequest, AiExecutionResult } from "./types.js";
import { ExecutionKernel } from "./kernel.js";

export interface AgentDefinition {
  id: string;
  version: string;
  capabilities: string[];
  systemInstruction: string;
}

export interface AgentRunRequest {
  agentId: string;
  input: unknown;
  taskType: string;
  tenantId: string;
  modelCapabilities: string[];
  budget?: AiExecutionRequest["budget"];
  metadata?: Record<string, string>;
}

export class AgentRuntime {
  constructor(
    private readonly agents: Map<string, AgentDefinition>,
    private readonly kernel: ExecutionKernel,
  ) {}

  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.id)) throw new Error("AGENT_ALREADY_REGISTERED");
    this.agents.set(agent.id, agent);
  }

  get(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId);
  }

  async run(request: AgentRunRequest): Promise<AiExecutionResult> {
    const agent = this.agents.get(request.agentId);
    if (!agent) {
      return {
        executionId: "",
        requestId: `agent:${request.agentId}`,
        status: "failed",
        failure: { code: "AGENT_NOT_FOUND", message: request.agentId, retryable: false },
      };
    }

    return this.kernel.execute({
      requestId: crypto.randomUUID(),
      tenantId: request.tenantId,
      agentId: agent.id,
      taskType: request.taskType,
      input: {
        systemInstruction: agent.systemInstruction,
        agentVersion: agent.version,
        input: request.input,
      },
      modelRequirements: { capabilities: request.modelCapabilities },
      budget: request.budget,
      metadata: request.metadata,
    });
  }
}
