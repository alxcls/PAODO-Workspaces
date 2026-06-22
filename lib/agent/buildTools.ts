// Assembles the full agent tool set and binds it to the configured LLM.
// Provider is selected via LLM_PROVIDER env var ("openai" default, "anthropic", "deepseek").
// Concrete infra dependencies are wired here and injected into tool constructors — tools
// themselves only depend on the ContainerRunner interface defined in interfaces.ts.

import { buildModel } from "./buildModel";
import { ExecCommandTool } from "./tools/execCommand";
import { AptInstallTool } from "./tools/aptInstall";
import { FileReadTool } from "./tools/fileRead";
import { FileEditTool } from "./tools/fileEdit";
import { FileWriteTool } from "./tools/fileWrite";
import { TodoWriteTool } from "./tools/todoWrite";
import { CompactContextTool } from "./tools/compactContext";
import { WebFetchTool } from "./tools/webFetch";
import { GlobTool } from "./tools/glob";
import { ListDirectoryTool } from "./tools/listDirectory";
import { AgentCallTool } from "./tools/agentCall";
import { ListAgentsTool } from "./tools/listAgents";
import { defaultContainerManager } from "../infra/docker/containerManager";
import { defaultWorkspaceStore } from "../workspace/workspaceStore";
import { broadcastToWorkspace } from "../infra/realtime/wsHub";
import type { IContainerManager, IWorkspaceStore } from "../infra/interfaces";
import type { AgentConfig, PrivilegedRunner, StreamingExecFn } from "./interfaces";

function makeContainerRunner(workspaceId: string, workspaceDir: string, containers: IContainerManager): PrivilegedRunner {
  return {
    exec:       (cmd, opts) => containers.exec(workspaceId, workspaceDir, cmd, opts),
    execAsRoot: (cmd)       => containers.execAsRoot(workspaceId, workspaceDir, cmd),
  };
}

function makeStreamingExecFn(workspaceId: string, workspaceDir: string, containers: IContainerManager): StreamingExecFn {
  return (cmd, opts) => containers.execStreaming(workspaceId, workspaceDir, cmd, opts);
}

export function loadAgentConfig(): AgentConfig {
  return {
    provider:             process.env.LLM_PROVIDER ?? "openai",
    reasoningEffort:      (process.env.REASONING_EFFORT ?? "low") as AgentConfig["reasoningEffort"],
    graphEnabled:         process.env.GRAPH_ENABLED !== "false",
    anthropicModel:       process.env.ANTHROPIC_MODEL,
    anthropicApiKey:      process.env.ANTHROPIC_API_KEY,
    anthropicCacheTtl1h:  process.env.ANTHROPIC_CACHE_TTL_1H === "true",
    openaiModel:          process.env.OPENAI_MODEL,
    openaiApiKey:         process.env.OPENAI_API_KEY,
    deepseekModel:        process.env.DEEPSEEK_MODEL,
    deepseekApiKey:       process.env.DEEPSEEK_API_KEY,
    execSilenceTimeoutMs: parseInt(process.env.EXEC_SILENCE_TIMEOUT_MS ?? "", 10) || 60_000,
    execMaxTimeoutMs:     parseInt(process.env.EXEC_MAX_TIMEOUT_MS ?? "", 10) || 30 * 60_000,
    skillInputMaxRetries:       parseInt(process.env.SKILL_INPUT_MAX_RETRIES ?? "", 10) || 2,
    skillOutputMaxRetries:      parseInt(process.env.SKILL_OUTPUT_MAX_RETRIES ?? "", 10) || 2,
    skillNeedsInputMaxRounds:   parseInt(process.env.SKILL_NEEDS_INPUT_MAX_ROUNDS ?? "", 10) || 2,
  };
}

export function buildTools(
  workspaceId: string,
  workspaceDir: string,
  config: AgentConfig,
  deps: { containers?: IContainerManager; store?: IWorkspaceStore } = {},
) {
  const containers = deps.containers ?? defaultContainerManager;
  const store = deps.store ?? defaultWorkspaceStore;
  const model = buildModel(config);
  const runner = makeContainerRunner(workspaceId, workspaceDir, containers);
  const streamExec = makeStreamingExecFn(workspaceId, workspaceDir, containers);
  const broadcast = (msg: string) => broadcastToWorkspace(workspaceId, msg);

  const tools = [
    new ExecCommandTool(streamExec, broadcast, { silenceTimeoutMs: config.execSilenceTimeoutMs, maxTimeoutMs: config.execMaxTimeoutMs }),
    new AptInstallTool(runner),
    new FileReadTool(runner),
    new FileEditTool(runner),
    new FileWriteTool(runner),
    new TodoWriteTool(workspaceId),
    new CompactContextTool(),
    new WebFetchTool(),
    new GlobTool(runner),
    new ListDirectoryTool(runner),
    ...(config.graphEnabled
      ? [new AgentCallTool(workspaceId, store, containers), new ListAgentsTool(workspaceId, store)]
      : []),
  ];

  const toolMap: Record<string, (typeof tools)[number]> = Object.fromEntries(
    tools.map((t) => [t.name, t])
  );

  const modelWithTools = model.bindTools(tools);

  return { modelWithTools, model, toolMap };
}
