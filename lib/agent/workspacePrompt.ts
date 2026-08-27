import type { BaseMessage, SystemMessage } from "@langchain/core/messages";
import type { Workspace } from "@/lib/workspace/types";
import type { LLMProviderConfig } from "./interfaces";
import { loadAgentConfig } from "./buildTools";
import { setSystemPrompt } from "./messageSerialization";
import { buildWorkspacePromptInputs } from "./promptContext";
import { buildPromptConfig, buildSystemPrompt } from "./systemPrompt";

export type PromptWorkspace = Pick<Workspace, "id" | "name" | "dir">;

/** The workspace's system prompt as it would be sent now: model config, AGENTS.md, drives, secrets. */
function buildWorkspaceSystemPrompt(ws: PromptWorkspace, config?: LLMProviderConfig): SystemMessage {
  return buildSystemPrompt(
    ws.name,
    buildPromptConfig(config ?? loadAgentConfig(ws.id)),
    buildWorkspacePromptInputs(ws.id, ws.dir),
  );
}

/** Replace (or insert) the system prompt on a live history, so each run picks up today's context. */
export function refreshWorkspaceSystemPrompt(
  ws: PromptWorkspace,
  messages: BaseMessage[],
  config?: LLMProviderConfig,
): void {
  setSystemPrompt(messages, buildWorkspaceSystemPrompt(ws, config));
}
