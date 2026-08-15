// Assembles the agent tool set and binds it to the configured model. The composition root: concrete
// infra is wired here and injected, so tools depend only on the interfaces in interfaces.ts.

import { buildModel, defaultModelSelection } from "./buildModel";
import type { ModelCallObserver } from "./modelGateway";
import { getProviderKey } from "../infra/security/providerKeyStore";
import { applyCompaction, type CompactLevel } from "./compact";
import { classifyToolStatus } from "./toolUtils";
import type { PostDispatchFn } from "./interfaces";
import { ExecCommandTool } from "./tools/execCommand";
import { StopTaskTool } from "./tools/stopTask";
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
import { WorkspaceHistoryTool } from "./tools/workspaceHistory";
import { WorkspaceRestoreTool } from "./tools/workspaceRestore";
import { DriveLsTool } from "./tools/driveLs";
import { DriveReadTool } from "./tools/driveRead";
import { DriveDeleteTool } from "./tools/driveDelete";
import { DriveDownloadTool } from "./tools/driveDownload";
import { DriveUploadTool } from "./tools/driveUpload";
import { getDrivesForWorkspace } from "@/lib/drives/store";
import { isCaller } from "@/lib/agent/network/graph";
import { defaultContainerManager } from "../infra/docker/defaultContainerManager";
import { defaultWorkspaceStore } from "@/lib/infra/workspace/registry";
import { getVersioning } from "../infra/services";
import { broadcastToWorkspace } from "../infra/realtime/wsHub";
import type {
  IContainerManager,
  IContainerExec,
  IBackgroundTasks,
  IAgentWorkspaceVersioning,
  IWorkspaceLookup,
} from "../infra/interfaces";
import type { AgentConfig, PrivilegedRunner, StreamingExecFn, BackgroundExecFn } from "./interfaces";

function makeContainerRunner(workspaceId: string, workspaceDir: string, containers: IContainerExec): PrivilegedRunner {
  return {
    exec: (cmd, opts) => containers.exec(workspaceId, workspaceDir, cmd, opts),
    execAsRoot: (cmd) => containers.execAsRoot(workspaceId, workspaceDir, cmd),
  };
}

function makeStreamingExecFn(workspaceId: string, workspaceDir: string, containers: IContainerExec): StreamingExecFn {
  return (cmd, opts) => containers.execStreaming(workspaceId, workspaceDir, cmd, opts);
}

function makeBackgroundExecFn(
  workspaceId: string,
  workspaceDir: string,
  containers: IBackgroundTasks,
): BackgroundExecFn {
  return (command) => containers.startBackground(workspaceId, workspaceDir, command);
}

// Resolves the LLM config for a run from the workspace's stored selection, falling back to the first
// available provider so a run never lands on one .env switched off. Some callers pass no workspaceId.
export function loadAgentConfig(workspaceId?: string): AgentConfig {
  const ws = workspaceId ? defaultWorkspaceStore.getWorkspace(workspaceId) : undefined;
  const fallback = defaultModelSelection();
  const provider = ws?.llmProvider ?? fallback.provider;
  const model = ws?.llmModel ?? fallback.model;
  const reasoningEffort = ws?.reasoningEffort ?? fallback.reasoningEffort;
  return {
    provider,
    reasoningEffort,
    model,
    // Entered in the app, not .env. Undefined when unset for this provider; runAgent's preflight
    // catches that and names the provider, rather than letting the SDK throw about a missing key.
    apiKey: getProviderKey(provider),
    graphEnabled: process.env.GRAPH_ENABLED !== "false",
    internetAccess: ws ? (ws.internetAccess ?? true) : false,
    anthropicCacheTtl1h: process.env.ANTHROPIC_CACHE_TTL_1H === "true",
    // 5 minutes, not 1: a quiet command is usually slow (npm install, a test suite that prints at the
    // end), not hung. The max-runtime guard below is what bounds a genuinely stuck one.
    silenceTimeoutMs: parseInt(process.env.EXEC_SILENCE_TIMEOUT_MS ?? "", 10) || 5 * 60_000,
    maxTimeoutMs: parseInt(process.env.EXEC_MAX_TIMEOUT_MS ?? "", 10) || 30 * 60_000,
    skillInputMaxRetries: parseInt(process.env.SKILL_INPUT_MAX_RETRIES ?? "", 10) || 2,
    skillOutputMaxRetries: parseInt(process.env.SKILL_OUTPUT_MAX_RETRIES ?? "", 10) || 2,
    skillNeedsInputMaxRounds: parseInt(process.env.SKILL_NEEDS_INPUT_MAX_ROUNDS ?? "", 10) || 2,
  };
}

export function buildTools(
  workspaceId: string,
  workspaceDir: string,
  config: AgentConfig,
  deps: {
    containers?: IContainerManager;
    store?: IWorkspaceLookup;
    versioning?: IAgentWorkspaceVersioning;
    /** Notified once per model call. Left out, the gateway only logs — nothing persists compaction. */
    observe?: ModelCallObserver;
  } = {},
) {
  const containers = deps.containers ?? defaultContainerManager;
  const store = deps.store ?? defaultWorkspaceStore;
  const versioning = deps.versioning ?? getVersioning();
  const model = buildModel(config, deps.observe ? { observe: deps.observe } : {});
  const runner = makeContainerRunner(workspaceId, workspaceDir, containers);
  const streamExec = makeStreamingExecFn(workspaceId, workspaceDir, containers);
  const backgroundExec = makeBackgroundExecFn(workspaceId, workspaceDir, containers);
  const broadcast = (msg: string) => broadcastToWorkspace(workspaceId, msg);
  const openOutputSink = (runId: string) => containers.openOutputSink(workspaceId, runId);

  const tools = [
    new ExecCommandTool(streamExec, backgroundExec, broadcast, config, workspaceDir, openOutputSink),
    new StopTaskTool(workspaceId, containers),
    // apt_install and http_get need a route out. Dropped from the bound list rather than left to
    // error, so the model cannot even attempt them when the workspace has no network.
    ...(config.internetAccess ? [new AptInstallTool(runner)] : []),
    new FileReadTool(runner),
    new FileEditTool(runner, workspaceDir, broadcast),
    new FileWriteTool(runner, workspaceDir, broadcast),
    new TodoWriteTool(workspaceId),
    new CompactContextTool(),
    ...(config.internetAccess ? [new WebFetchTool(runner)] : []),
    new GlobTool(runner),
    new ListDirectoryTool(runner),
    new WorkspaceHistoryTool(workspaceId, workspaceDir, versioning),
    // Signal-only: the runner performs the restore against the platform versioning (runner.ts).
    new WorkspaceRestoreTool(),
    // Calling tools go only to a caller (a workspace with outgoing edges). A pure callee
    // never receives call_agent/list_agents, even when the graph feature is enabled.
    ...(config.graphEnabled && isCaller(workspaceId)
      ? [new AgentCallTool(workspaceId, store, containers, config), new ListAgentsTool(workspaceId, store)]
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

  const toolMap: Record<string, (typeof tools)[number]> = Object.fromEntries(tools.map((t) => [t.name, t]));

  const modelWithTools = model.bindTools(tools);

  return { modelWithTools, model, toolMap, signalHandlers: buildSignalHandlers() };
}

// Signal handlers run after a tool turn settles; a new signal tool needs only an entry here. Closure-
// free so it is directly testable, and each handler catches its own errors per the PostDispatchFn contract.
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
          ctx.log.warn({ err, compactLevel: level }, "agent compact_context failed");
        }
      }
    },
  };
}
