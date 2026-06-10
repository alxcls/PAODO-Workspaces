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
export type StreamingExecFn = (
  cmd: string[],
  opts: { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void },
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

export interface AgentConfig extends LLMProviderConfig {
  graphEnabled: boolean;
  execSilenceTimeoutMs: number;
  execMaxTimeoutMs: number;
}
