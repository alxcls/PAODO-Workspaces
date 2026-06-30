// Assembles the full agent tool set and binds it to the configured LLM.
// Provider is selected via LLM_PROVIDER env var ("openai" default, "anthropic", "deepseek").
// Concrete infra dependencies are wired here and injected into tool constructors — tools
// themselves only depend on the ContainerRunner interface defined in interfaces.ts.

import { buildModel } from "./buildModel";
import { applyCompaction, type CompactLevel } from "./compact";
import { classifyToolStatus } from "./toolUtils";
import type { PostDispatchFn } from "./interfaces";
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
import { RunPrivilegedScriptTool } from "./tools/runPrivilegedScript";
import { AgentCallTool } from "./tools/agentCall";
import { ListAgentsTool } from "./tools/listAgents";
import { WorkspaceHistoryTool } from "./tools/workspaceHistory";
import { WorkspaceRestoreTool } from "./tools/workspaceRestore";
import { DriveLsTool } from "./tools/driveLs";
import { DriveReadTool } from "./tools/driveRead";
import { DriveDeleteTool } from "./tools/driveDelete";
import { DriveDownloadTool } from "./tools/driveDownload";
import { DriveUploadTool } from "./tools/driveUpload";
import { getDrivesForWorkspace } from "../workspace/driveStore";
import { isCaller } from "../workspace/workspaceGraph";
import { defaultContainerManager } from "../infra/docker/containerManager";
import { defaultWorkspaceStore } from "../workspace/workspaceStore";
import { getVersioning } from "../infra/services";
import { broadcastToWorkspace } from "../infra/realtime/wsHub";
import type { IContainerManager, IWorkspaceStore, IWorkspaceVersioning } from "../infra/interfaces";
import type { AgentConfig, PrivilegedRunner, StreamingExecFn } from "./interfaces";

function makeContainerRunner(workspaceId: string, workspaceDir: string, containers: IContainerManager): PrivilegedRunner {
  return {
    exec:             (cmd, opts) => containers.exec(workspaceId, workspaceDir, cmd, opts),
    execAsRoot:       (cmd)       => containers.execAsRoot(workspaceId, workspaceDir, cmd),
    execAsPrivileged: (cmd, opts) => containers.execAsPrivileged(workspaceId, workspaceDir, cmd, opts),
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
    silenceTimeoutMs: parseInt(process.env.EXEC_SILENCE_TIMEOUT_MS ?? "", 10) || 60_000,
    maxTimeoutMs:     parseInt(process.env.EXEC_MAX_TIMEOUT_MS ?? "", 10) || 30 * 60_000,
    skillInputMaxRetries:       parseInt(process.env.SKILL_INPUT_MAX_RETRIES ?? "", 10) || 2,
    skillOutputMaxRetries:      parseInt(process.env.SKILL_OUTPUT_MAX_RETRIES ?? "", 10) || 2,
    skillNeedsInputMaxRounds:   parseInt(process.env.SKILL_NEEDS_INPUT_MAX_ROUNDS ?? "", 10) || 2,
  };
}

export function buildTools(
  workspaceId: string,
  workspaceDir: string,
  config: AgentConfig,
  deps: { containers?: IContainerManager; store?: IWorkspaceStore; versioning?: IWorkspaceVersioning } = {},
) {
  const containers = deps.containers ?? defaultContainerManager;
  const store = deps.store ?? defaultWorkspaceStore;
  const versioning = deps.versioning ?? getVersioning();
  const model = buildModel(config);
  const runner = makeContainerRunner(workspaceId, workspaceDir, containers);
  const streamExec = makeStreamingExecFn(workspaceId, workspaceDir, containers);
  const broadcast = (msg: string) => broadcastToWorkspace(workspaceId, msg);

  const tools = [
    new ExecCommandTool(streamExec, broadcast, config),
    new AptInstallTool(runner),
    new FileReadTool(runner),
    new FileEditTool(runner),
    new FileWriteTool(runner),
    new TodoWriteTool(workspaceId),
    new CompactContextTool(),
    new WebFetchTool(),
    new GlobTool(runner),
    new ListDirectoryTool(runner),
    new RunPrivilegedScriptTool(workspaceId, runner),
    new WorkspaceHistoryTool(workspaceId, workspaceDir, versioning),
    // Signal-only: the runner performs the restore against the platform versioning (runner.ts).
    new WorkspaceRestoreTool(),
    // Calling tools go only to a caller (a workspace with outgoing edges). A pure callee
    // never receives call_agent/list_agents, even when the graph feature is enabled.
    ...(config.graphEnabled && isCaller(workspaceId)
      ? [
          new AgentCallTool(workspaceId, store, containers, config),
          new ListAgentsTool(workspaceId, store),
        ]
      : []),
    // Drive tools are injected only when this workspace has at least one connected drive,
    // keeping the prompt lean for the common no-drive case.
    ...(getDrivesForWorkspace(workspaceId).length > 0
      ? [
          new DriveLsTool(workspaceId),
          new DriveReadTool(workspaceId),
          new DriveDeleteTool(workspaceId),
          new DriveDownloadTool(workspaceId, runner),
          new DriveUploadTool(workspaceId, workspaceDir),
        ]
      : []),
  ];

  const toolMap: Record<string, (typeof tools)[number]> = Object.fromEntries(
    tools.map((t) => [t.name, t])
  );

  const modelWithTools = model.bindTools(tools);

  return { modelWithTools, model, toolMap, signalHandlers: buildSignalHandlers() };
}

// Signal handlers run after a tool turn settles. Adding an entry here is the ONLY change needed
// when a new signal tool is introduced — runAgent dispatches generically via this map and never
// changes. Exported (and closure-free — all state arrives via ctx) so it can be unit-tested
// directly rather than through a hand-mirrored copy. Per the PostDispatchFn contract, every
// handler catches and logs its own errors so a side-effect failure never aborts the run.
export function buildSignalHandlers(): Record<string, PostDispatchFn> {
  return {
    workspace_restore: async (args, resultStr, ctx) => {
      const target = (args as { sha?: string }).sha;
      if (target && classifyToolStatus(resultStr) === "ok" && ctx.versioning) {
        try {
          const ok = await ctx.versioning.restore(ctx.workspaceId, ctx.workspaceDir, target);
          if (ok) ctx.notify({ type: "snapshot_restored", sha: target });
          else ctx.log.warn({ target }, "agent restore: target snapshot not found");
        } catch (err) {
          ctx.log.warn({ err, target }, "agent restore failed");
        }
      }
    },
    compact_context: async (args, _resultStr, ctx) => {
      const { level, next_step } = args as { level?: CompactLevel; next_step?: string };
      if (level && next_step && ctx.model) {
        try {
          await applyCompaction(ctx.model, ctx.messages, level, next_step);
        } catch (err) {
          ctx.log.warn({ err, level }, "agent compact_context failed");
        }
      }
    },
  };
}
