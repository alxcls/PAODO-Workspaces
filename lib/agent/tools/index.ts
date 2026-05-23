// Assembles the full agent tool set and binds it to the OpenAI model.
// Each tool receives the workspace directory and/or workspace ID to scope operations to the correct workspace.
import { ChatOpenAI } from "@langchain/openai";
import { buildExecCommandTool } from "./execCommand";
import { buildFileReadTool } from "./fileRead";
import { buildFileEditTool } from "./fileEdit";
import { buildFileWriteTool } from "./fileWrite";
import { buildTodoWriteTool } from "./todoWrite";
import { buildWebFetchTool } from "./webFetch";
import { buildGlobTool } from "./glob";
import { buildListDirectoryTool } from "./listDirectory";
import { buildAgentCallTool } from "./agentCall";
import { buildListAgentsTool } from "./listAgents";

export function buildTools(workspaceId: string, workspaceDir: string) {
  const model = new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL ?? "gpt-5.1-codex-mini",
    openAIApiKey: process.env.OPENAI_API_KEY,
  });

  const tools = [
    buildExecCommandTool(workspaceId, workspaceDir),
    buildFileReadTool(workspaceId, workspaceDir),
    buildFileEditTool(workspaceId, workspaceDir),
    buildFileWriteTool(workspaceId, workspaceDir),
    buildTodoWriteTool(workspaceId),
    buildWebFetchTool(),
    buildGlobTool(workspaceId, workspaceDir),
    buildListDirectoryTool(workspaceId, workspaceDir),
    buildAgentCallTool(workspaceId),
    buildListAgentsTool(workspaceId),
  ];

  const toolMap: Record<string, (typeof tools)[number]> = Object.fromEntries(
    tools.map((t) => [t.name, t])
  );

  const modelWithTools = model.bindTools(tools);

  return { modelWithTools, toolMap };
}
