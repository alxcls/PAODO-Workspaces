// Shared type definitions for the agent layer: exec runners, streaming exec, LLM provider
// config, and the combined AgentConfig consumed by buildTools and the runner.
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { IWorkspaceVersioning } from "../infra/interfaces";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
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

// The full set of reasoning-effort levels across all providers, quietest first. Each provider accepts
// only a SUBSET (see PROVIDER_METADATA in buildModel.ts): OpenAI takes none…xhigh, Anthropic low…max,
// DeepSeek none. A stored/selected value is validated against the chosen provider's subset, not this
// union — so this type is deliberately the widest thing any provider might carry.
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Per-workspace LLM selection: provider + model + reasoning effort are chosen in the UI and stored on
// the workspace record (not in .env). When a workspace has made no choice, the agent falls back to
// DEFAULT_LLM. .env carries only the provider API keys.
export interface WorkspaceLlmSelection {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export const DEFAULT_LLM: WorkspaceLlmSelection = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  reasoningEffort: "low",
};

export interface LLMProviderConfig {
  provider: string;
  reasoningEffort: ReasoningEffort;
  anthropicModel: string | undefined;
  anthropicApiKey: string | undefined;
  anthropicCacheTtl1h: boolean;
  openaiModel: string | undefined;
  openaiApiKey: string | undefined;
  deepseekModel: string | undefined;
  deepseekApiKey: string | undefined;
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
}

// Context threaded to each PostDispatchFn after a tool turn settles. Handlers receive the live
// messages array (mutable — compact rewrites it), the versioning service, and the notify/log
// seams so they can broadcast WS events and log warnings without importing infra directly.
export interface PostDispatchContext {
  messages: BaseMessage[];
  versioning: IWorkspaceVersioning | undefined;
  workspaceId: string;
  workspaceDir: string;
  /** The bare model (no bound tools) — required by the compact handler to summarize history. Absent for handlers that don't need it. */
  model?: BaseChatModel;
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
