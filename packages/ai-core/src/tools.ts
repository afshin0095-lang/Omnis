import type { ToolDefinition, ToolContext } from "./types.js";

export class ToolRuntime {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`TOOL_ALREADY_REGISTERED:${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  async invoke(name: string, input: unknown, context: ToolContext, requiredPermission?: string): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error("TOOL_NOT_FOUND");
    if (requiredPermission && !tool.permissions.includes(requiredPermission)) throw new Error("TOOL_PERMISSION_DENIED");
    if (context.signal.aborted) throw new Error("TOOL_CANCELLED");
    return tool.invoke(input, context);
  }

  list(): ToolDefinition[] { return [...this.tools.values()]; }
}
