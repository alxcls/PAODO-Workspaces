// Assembles the full agent tool set and binds it to the configured LLM.
// Provider is selected via LLM_PROVIDER env var ("openai" default, "anthropic").
// Each tool receives the workspace directory and/or workspace ID to scope operations to the correct workspace.
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
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
  const provider = process.env.LLM_PROVIDER ?? "openai";

  let model: ChatOpenAI | ChatAnthropic;
  if (provider === "anthropic") {
    const modelName = process.env.ANTHROPIC_MODEL;
    if (!modelName) throw new Error("ANTHROPIC_MODEL is not set in .env");
    model = new ChatAnthropic({ model: modelName, apiKey: process.env.ANTHROPIC_API_KEY });
  } else {
    const modelName = process.env.OPENAI_MODEL;
    if (!modelName) throw new Error("OPENAI_MODEL is not set in .env");
    model = new ChatOpenAI({ modelName, openAIApiKey: process.env.OPENAI_API_KEY });
  }

  const tools = [
    buildExecCommandTool(workspaceId, workspaceDir),
    buildFileReadTool(workspaceId, workspaceDir),
    buildFileEditTool(workspaceId, workspaceDir),
    buildFileWriteTool(workspaceId, workspaceDir),
    buildTodoWriteTool(workspaceId),
    buildWebFetchTool(),
    buildGlobTool(workspaceId, workspaceDir),
    buildListDirectoryTool(workspaceId, workspaceDir),
    ...(process.env.GRAPH_ENABLED === "true"
      ? [buildAgentCallTool(workspaceId), buildListAgentsTool(workspaceId)]
      : []),
  ];

  const toolMap: Record<string, (typeof tools)[number]> = Object.fromEntries(
    tools.map((t) => [t.name, t])
  );

  const modelWithTools = model.bindTools(tools);

  return { modelWithTools, model, toolMap };
}
