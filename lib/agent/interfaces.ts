// Shared type definitions for the agent layer: exec runners, streaming exec, LLM provider
// config, and the combined AgentConfig consumed by buildTools and the runner.
import type { BaseMessage } from "@langchain/core/messages";
import type { IWorkspaceVersionRestorer, OutputSink } from "../infra/interfaces";
import type { ReasoningEffort } from "../models/llmSelection";
import type { ModelGateway } from "./modelGateway";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the docker client's capture ceiling cut the output — stdout is only the leading part. */
  truncated?: boolean;
}

export interface ExecRunner {
  exec(cmd: string[], opts?: { stdin?: string }): Promise<ExecResult>;
}

export interface PrivilegedRunner extends ExecRunner {
  execAsRoot(cmd: string[]): Promise<ExecResult>;
}

// Backward-compat alias. ensureRunning removed — no tool ever calls it directly.
export type ContainerRunner = PrivilegedRunner;

// Per-chunk streaming executor for tools that need live output (e.g. ExecCommandTool).
// Kept separate from ContainerRunner so non-streaming tools are not forced to implement it.
// signal aborts the in-container process group (real kill), not just the host-side exec client.
export type StreamingExecFn = (
  cmd: string[],
  opts: { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void; signal?: AbortSignal },
) => Promise<{ code: number | null }>;

// Launches a shell command detached from the exec kill path (dev servers etc.) and returns at once
// with a taskId + the in-container log path. Used by execute_command's run_in_background branch.
// Kept separate from StreamingExecFn so the streaming/timeout machinery never touches this path.
export type BackgroundExecFn = (command: string) => Promise<{ taskId: string; logFile: string }>;

// Opens a sink for one command's over-cap output. Called lazily — only once a command has already
// blown the inline cap, so the common case never spawns the extra process this needs.
export type OutputSinkFn = (runId: string) => OutputSink;

// The resolved LLM config for one run: the single provider that was selected, plus the model and key
// that belong to it. Deliberately provider-agnostic — adding a provider adds an entry to the PROVIDERS
// registry (buildModel.ts), never a field here. Each provider's env var, builder and capabilities all
// live in that one registry.
export interface LLMProviderConfig {
  provider: string;
  reasoningEffort: ReasoningEffort;
  /** The selected provider's model id — always set (workspace selection, else DEFAULT_LLM). */
  model: string;
  /** The selected provider's API key, read from the env var its registry entry declares. */
  apiKey: string | undefined;
  /** Anthropic-only: opt into the 1h prompt-cache beta. Inert for providers without prompt caching. */
  anthropicCacheTtl1h: boolean;
}

export interface ExecConfig {
  silenceTimeoutMs: number;
  maxTimeoutMs: number;
}

export interface SkillConfig {
  skillInputMaxRetries: number;
  skillOutputMaxRetries: number;
  skillNeedsInputMaxRounds: number;
}

export interface AgentConfig extends LLMProviderConfig, ExecConfig, SkillConfig {
  graphEnabled: boolean;
  internetAccess: boolean;
}

// Context threaded to each PostDispatchFn after a tool turn settles. Handlers receive the live
// messages array (mutable — compact rewrites it), the versioning service, and the notify/log
// seams so they can broadcast WS events and log warnings without importing infra directly.
export interface PostDispatchContext {
  messages: BaseMessage[];
  versioning: IWorkspaceVersionRestorer | undefined;
  workspaceId: string;
  workspaceDir: string;
  /** The bare model (no bound tools) — required by the compact handler to summarize history. Absent for handlers that don't need it. */
  model?: ModelGateway;
  notify: (msg: object) => void;
  log: { warn(obj: object, msg: string): void; debug(obj: object, msg: string): void };
}

// Called by the runner after every settled tool turn for any tool that registered a side-effect
// (e.g. workspace_restore performs the actual git reset, compact_context rewrites messages).
// Returning void; errors should be caught and logged inside the handler.
export type PostDispatchFn = (
  args: Record<string, unknown>,
  resultStr: string,
  ctx: PostDispatchContext,
) => Promise<void>;
