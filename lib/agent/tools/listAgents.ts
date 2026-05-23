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
