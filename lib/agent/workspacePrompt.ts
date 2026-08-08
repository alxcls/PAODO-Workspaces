import type { BaseMessage, SystemMessage } from "@langchain/core/messages";
import { contentToParagraphs } from "@/lib/transcript/content";
import type { Workspace } from "@/lib/workspace/types";
import type { LLMProviderConfig } from "./interfaces";
import { loadAgentConfig } from "./buildTools";
import { setSystemPrompt } from "./messageSerialization";
import { buildWorkspacePromptInputs } from "./promptContext";
import { buildPromptConfig, buildSystemPrompt } from "./systemPrompt";

export type PromptWorkspace = Pick<Workspace, "id" | "name" | "dir">;

/** The workspace's system prompt as it would be sent now: model config, AGENTS.md, drives, secrets. */
export function buildWorkspaceSystemPrompt(ws: PromptWorkspace, config?: LLMProviderConfig): SystemMessage {
  return buildSystemPrompt(
    ws.name,
    buildPromptConfig(config ?? loadAgentConfig(ws.id)),
    buildWorkspacePromptInputs(ws.id, ws.dir),
  );
}

/**
 * The same prompt as readable text, for the usage dashboard's "System prompt" section. Rendered here
 * rather than by the reader: this module knows its own message is a list of authored sections, so it
 * is the one place that can say they are paragraphs.
 */
export function workspaceSystemPromptText(ws: PromptWorkspace, config?: LLMProviderConfig): string {
  return contentToParagraphs(buildWorkspaceSystemPrompt(ws, config).content);
}

/** Replace (or insert) the system prompt on a live history, so each run picks up today's context. */
export function refreshWorkspaceSystemPrompt(
  ws: PromptWorkspace,
  messages: BaseMessage[],
  config?: LLMProviderConfig,
): void {
  setSystemPrompt(messages, buildWorkspaceSystemPrompt(ws, config));
}
