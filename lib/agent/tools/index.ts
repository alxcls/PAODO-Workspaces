// Assembles the full agent tool set and binds it to the configured LLM.
// Provider is selected via LLM_PROVIDER env var ("openai" default, "anthropic").
// Each tool receives the workspace directory and/or workspace ID to scope operations to the correct workspace.
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { buildExecCommandTool } from "./execCommand";
import { buildAptInstallTool } from "./aptInstall";
import { buildFileReadTool } from "./fileRead";
import { buildFileEditTool } from "./fileEdit";
import { buildFileWriteTool } from "./fileWrite";
import { buildTodoWriteTool } from "./todoWrite";
import { buildWebFetchTool } from "./webFetch";
import { buildGlobTool } from "./glob";
import { buildListDirectoryTool } from "./listDirectory";
import { buildAgentCallTool } from "./agentCall";
import { buildListAgentsTool } from "./listAgents";

type ReasoningEffort = "low" | "medium" | "high";
const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 4_000,
  medium: 10_000,
  high: 20_000,
};

export function buildTools(workspaceId: string, workspaceDir: string) {
  const provider = process.env.LLM_PROVIDER ?? "openai";
  const effort = (process.env.REASONING_EFFORT ?? "low") as ReasoningEffort;

  let model: ChatOpenAI | ChatAnthropic;
  if (provider === "anthropic") {
    const modelName = process.env.ANTHROPIC_MODEL;
    if (!modelName) throw new Error("ANTHROPIC_MODEL is not set in .env");
    const use1hTTL = process.env.ANTHROPIC_CACHE_TTL_1H === "true";
    model = new ChatAnthropic({
      model: modelName,
      apiKey: process.env.ANTHROPIC_API_KEY,
      thinking: { type: "enabled", budget_tokens: ANTHROPIC_THINKING_BUDGET[effort] },
      ...(use1hTTL && {
        clientOptions: {
          defaultHeaders: { "anthropic-beta": "prompt-caching-scope-2026-01-05" },
        },
      }),
    });
  } else {
    const modelName = process.env.OPENAI_MODEL;
    if (!modelName) throw new Error("OPENAI_MODEL is not set in .env");
    model = new ChatOpenAI({
      model: modelName,
      openAIApiKey: process.env.OPENAI_API_KEY,
      useResponsesApi: true,
      reasoning: { effort, summary: "auto" },
    });
  }

  const tools = [
    buildExecCommandTool(workspaceId, workspaceDir),
    buildAptInstallTool(workspaceId, workspaceDir),
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
