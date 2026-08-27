import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { getStore } from "@/lib/infra/services";
import * as conversations from "@/lib/conversations/store";
import * as broker from "@/lib/agent/runBroker";
import { refreshWorkspaceSystemPrompt } from "@/lib/agent/workspacePrompt";
import type { SessionOrigin } from "@/lib/usage/types";
import { ExecutionCapacityReachedError } from "@/lib/agent/executionCapacity";
import { ConversationNotFoundError, RunInputInvalidError } from "./errors";

export type RunConversationTarget = { mode: "existing"; id: string } | { mode: "create" };

export interface StartWorkspaceRunInput {
  prompt: string;
  origin: SessionOrigin;
  conversation: RunConversationTarget;
}

export interface WorkspaceRunReceipt {
  workspaceId: string;
  conversationId: string;
  origin: SessionOrigin;
  /** False when a run was already in flight for this conversation; nothing new was started. */
  started: boolean;
}

export interface StartWorkspaceRunDeps {
  workspaces?: Pick<IWorkspaceStore, "getWorkspace">;
  conversations?: Pick<typeof conversations, "createConversation" | "getMessages" | "persist">;
  broker?: Pick<typeof broker, "startRun">;
  /** Injected so a test can assert the prompt was refreshed on the array the broker receives. */
  refreshPrompt?: typeof refreshWorkspaceSystemPrompt;
}

/** Returns null when the workspace does not exist, mirroring setWorkspaceSchedule. */
export function startWorkspaceRun(
  workspaceId: string,
  input: StartWorkspaceRunInput,
  deps: StartWorkspaceRunDeps = {},
): WorkspaceRunReceipt | null {
  const prompt = input.prompt.trim();
  if (!prompt) throw new RunInputInvalidError("prompt is required", { field: "prompt" });

  const workspaces = deps.workspaces ?? getStore();
  const ws = workspaces.getWorkspace(workspaceId);
  if (!ws) return null;

  const conversationStore = deps.conversations ?? conversations;
  const conversationId =
    input.conversation.mode === "create" ? conversationStore.createConversation(ws.id).id : input.conversation.id;
  const messages = conversationStore.getMessages(ws.id, conversationId);
  if (!messages) throw new ConversationNotFoundError();

  (deps.refreshPrompt ?? refreshWorkspaceSystemPrompt)(ws, messages);
  const { alreadyRunning, capacityReached } = (deps.broker ?? broker).startRun({
    workspaceId: ws.id,
    workspaceName: ws.name,
    workspaceDir: ws.dir,
    conversationId,
    messages,
    userInput: prompt,
    maxIterations: ws.maxIterations,
    maxRunMinutes: ws.maxRunMinutes,
    origin: input.origin,
  });

  if (capacityReached) {
    const error = new ExecutionCapacityReachedError(capacityReached, {
      workspaceId: ws.id,
      conversationId,
      origin: input.origin,
    });
    // A refused attempt remains visible after the pressure has passed, including scheduled fires.
    messages.push(new HumanMessage(prompt), new AIMessage(error.message));
    conversationStore.persist(ws.id, conversationId);
    throw error;
  }

  return {
    workspaceId: ws.id,
    conversationId,
    origin: input.origin,
    started: !alreadyRunning,
  };
}
