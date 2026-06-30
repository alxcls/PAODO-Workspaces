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
  // Runs as the non-root `privd` user — the identity that owns locked/hidden/privileged files.
  // Used only by the run_privileged_script tool. `cwd` runs the script from its own directory.
  execAsPrivileged(cmd: string[], opts?: { cwd?: string }): Promise<ExecResult>;
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

export type ReasoningEffort = "low" | "medium" | "high";

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
