// Trigger-neutral conversation queries and mutations. Routes own HTTP and streaming; this operation
// owns which history is authoritative while a run is live and how active/running state is projected.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import * as conversations from "@/lib/conversations/store";
import type { ConversationMeta } from "@/lib/conversations/store";
import * as broker from "@/lib/agent/runBroker";
import { messagesToTranscript } from "@/lib/agent/messageSerialization";
import { getConversationOutputTokens } from "@/lib/usage/queries";
import { startWorkspaceRun } from "@/lib/operations/agent/run";
import { ConversationNotFoundError } from "@/lib/operations/agent/errors";

type ConversationStore = Pick<
  typeof conversations,
  | "listConversations"
  | "createConversation"
  | "getMeta"
  | "getMessages"
  | "getPersistedMessages"
  | "getActiveId"
  | "setActiveId"
>;

type ConversationBroker = Pick<typeof broker, "runningConversationIds" | "isRunning" | "peekUserInput" | "stop">;

export interface ConversationOperationDeps {
  workspaces?: Pick<IWorkspaceStore, "getWorkspace">;
  conversations?: ConversationStore;
  broker?: ConversationBroker;
  transcript?: typeof messagesToTranscript;
  outputTokens?: typeof getConversationOutputTokens;
  startRun?: typeof startWorkspaceRun;
}

export type ConversationSummary = ConversationMeta & { running: boolean };

export interface ConversationDetail {
  meta: ConversationMeta;
  running: boolean;
  userInput: string | null;
  transcript: ReturnType<typeof messagesToTranscript>;
}

export interface ConversationCollection {
  conversations: ConversationSummary[];
  active: (Omit<ConversationDetail, "meta"> & { id: string }) | null;
}

function dependencies(deps: ConversationOperationDeps) {
  return {
    workspaces: deps.workspaces ?? getStore(),
    conversations: deps.conversations ?? conversations,
    broker: deps.broker ?? broker,
    transcript: deps.transcript ?? messagesToTranscript,
    outputTokens: deps.outputTokens ?? getConversationOutputTokens,
    startRun: deps.startRun ?? startWorkspaceRun,
  };
}

function detail(
  workspaceId: string,
  conversationId: string,
  meta: ConversationMeta,
  deps: ReturnType<typeof dependencies>,
): ConversationDetail {
  const running = deps.broker.isRunning(workspaceId, conversationId);
  // During a run, the live array already includes the user turn. The client renders that turn from
  // userInput, so projecting the persisted snapshot avoids duplicating the user's message.
  const messages = running
    ? deps.conversations.getPersistedMessages(workspaceId, conversationId)
    : deps.conversations.getMessages(workspaceId, conversationId);
  if (!messages) throw new ConversationNotFoundError();
  return {
    meta,
    running,
    userInput: running ? deps.broker.peekUserInput(workspaceId, conversationId) : null,
    transcript: deps.transcript(messages, deps.outputTokens(workspaceId, conversationId)),
  };
}

export function listWorkspaceConversations(
  workspaceId: string,
  options: { includeActive?: boolean } = {},
  suppliedDeps: ConversationOperationDeps = {},
): ConversationCollection | null {
  const deps = dependencies(suppliedDeps);
  if (!deps.workspaces.getWorkspace(workspaceId)) return null;

  const runningIds = new Set(deps.broker.runningConversationIds(workspaceId));
  const list = deps.conversations
    .listConversations(workspaceId)
    .map((meta) => ({ ...meta, running: runningIds.has(meta.id) }));
  if (!options.includeActive || list.length === 0) return { conversations: list, active: null };

  const activeMeta = list[0];
  let active: ConversationDetail;
  try {
    active = detail(workspaceId, activeMeta.id, activeMeta, deps);
  } catch (err) {
    // A conversation removed between the index and message reads should not make the whole list
    // unavailable. The next poll will receive the updated index; only the optional inline detail is lost.
    if (err instanceof ConversationNotFoundError) return { conversations: list, active: null };
    throw err;
  }
  return {
    conversations: list,
    active: {
      id: activeMeta.id,
      running: active.running,
      userInput: active.userInput,
      transcript: active.transcript,
    },
  };
}

export function getWorkspaceConversation(
  workspaceId: string,
  conversationId: string,
  suppliedDeps: ConversationOperationDeps = {},
): ConversationDetail | null {
  const deps = dependencies(suppliedDeps);
  if (!deps.workspaces.getWorkspace(workspaceId)) return null;
  const meta = deps.conversations.getMeta(workspaceId, conversationId);
  if (!meta) throw new ConversationNotFoundError();
  return detail(workspaceId, conversationId, meta, deps);
}

export function createWorkspaceConversation(
  workspaceId: string,
  suppliedDeps: ConversationOperationDeps = {},
): { workspaceId: string; conversation: ConversationSummary } | null {
  const deps = dependencies(suppliedDeps);
  if (!deps.workspaces.getWorkspace(workspaceId)) return null;
  const meta = deps.conversations.createConversation(workspaceId);
  return { workspaceId, conversation: { ...meta, running: false } };
}

export function stopWorkspaceConversation(
  workspaceId: string,
  conversationId: string,
  suppliedDeps: ConversationOperationDeps = {},
): { workspaceId: string; conversationId: string; stopped: boolean } | null {
  const deps = dependencies(suppliedDeps);
  if (!deps.workspaces.getWorkspace(workspaceId)) return null;
  return { workspaceId, conversationId, stopped: deps.broker.stop(workspaceId, conversationId) };
}

export function prepareWorkspaceChat(
  workspaceId: string,
  input: { message?: string; conversationId?: string },
  suppliedDeps: ConversationOperationDeps = {},
): { workspaceId: string; conversationId: string; started: boolean | null } | null {
  const deps = dependencies(suppliedDeps);
  if (!deps.workspaces.getWorkspace(workspaceId)) return null;

  const conversationId = input.conversationId ?? deps.conversations.getActiveId(workspaceId);
  if (!deps.conversations.getMessages(workspaceId, conversationId)) throw new ConversationNotFoundError();

  const prompt = input.message?.trim();
  if (!prompt) return { workspaceId, conversationId, started: null };

  const receipt = deps.startRun(workspaceId, {
    prompt,
    origin: "chat",
    conversation: { mode: "existing", id: conversationId },
  });
  if (!receipt) return null;
  if (receipt.started) deps.conversations.setActiveId(workspaceId, conversationId);
  return { workspaceId, conversationId, started: receipt.started };
}
