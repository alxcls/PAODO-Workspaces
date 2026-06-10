// Tool that lists the agents reachable from this workspace via call_agent.
// Reads the workspace graph to find callee IDs, then resolves their display names.
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { getCallees } from "../../infra/workspaceGraph";
import type { IWorkspaceStore } from "../../infra/interfaces";

const schema = z.object({});

export class ListAgentsTool extends StructuredTool<typeof schema> {
  name = "list_agents";
  description = "List all agents this workspace can contact via call_agent";
  schema = schema;

  constructor(
    private readonly callerWorkspaceId: string,
    private readonly store: IWorkspaceStore,
  ) {
    super();
  }

  protected async _call(_input: z.infer<typeof schema>): Promise<string> {
    const calleeIds = getCallees(this.callerWorkspaceId);
    if (!calleeIds.length) return "No agents connected to this workspace.";
    const names = calleeIds.map((id) => this.store.getWorkspace(id)?.name ?? id);
    return `Connected agents:\n${names.map((n) => `- ${n}`).join("\n")}`;
  }
}
