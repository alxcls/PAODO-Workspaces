import type { ReasoningEffort } from "../models/llmSelection";

/** The workspace entity shared by operations, runtime consumers, and persistence adapters. */
export interface Workspace {
  id: string;
  name: string;
  dir: string;
  createdAt: Date;
  maxIterations: number;
  /** Wall-clock limit for one run, including model, tool, validation, and child-agent wait time. */
  maxRunMinutes: number;
  /** Workspace-level context shown in the UI and exposed to external MCP clients as instructions. */
  description?: string;
  llmProvider?: string;
  llmModel?: string;
  reasoningEffort?: ReasoningEffort;
  /** Whether the workspace container is permitted to route traffic to the internet. */
  internetAccess: boolean;
}
