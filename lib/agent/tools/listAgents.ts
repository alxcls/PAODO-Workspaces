// Tool that lists the agents reachable from this workspace via call_agent.
// Reads the workspace graph to find callee IDs, then resolves their display names.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getCallees } from "../../infra/workspaceGraph";
import { getWorkspace } from "../../infra/workspaceStore";

export function buildListAgentsTool(callerWorkspaceId: string) {
  return tool(
    async () => {
      const calleeIds = getCallees(callerWorkspaceId);
      if (!calleeIds.length) return "No agents connected to this workspace.";
      const names = calleeIds.map((id) => getWorkspace(id)?.name ?? id);
      return `Connected agents:\n${names.map((n) => `- ${n}`).join("\n")}`;
    },
    {
      name: "list_agents",
      description: "List all agents this workspace can contact via call_agent",
      schema: z.object({}),
    }
  );
}
