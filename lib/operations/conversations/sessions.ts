// A conversation's runs, each as a short preview to choose from, or one run in full with what it cost. Read-only:
// starting or stopping a run is the API's and MCP's job; the grouping is the dashboard's own, so both agree.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import * as conversations from "@/lib/conversations/store";
import type { Currency } from "@/lib/models/currency";
import { ConversationNotFoundError, SessionNotFoundError } from "@/lib/operations/agent/errors";
import { listSessionTexts, listUsageLight } from "@/lib/usage/queries";
import { groupBySessions, type LightSession } from "@/lib/usage/sessions";
import { uncachedInputTokens } from "@/lib/usage/tokenUsage";
import { countChars } from "./calls";
import type { RunErrorRecord, SessionOrigin, SessionStatus, SessionTextRecord } from "@/lib/usage/types";

/** The most of each text the list shows; one session returns both whole. */
export const SESSION_PREVIEW_MAX_CHARS = 200;

export interface ConversationSessionsDeps {
  workspaces?: Pick<IWorkspaceStore, "getWorkspace">;
  conversations?: Pick<typeof conversations, "getMeta">;
  usage?: typeof listUsageLight;
  texts?: typeof listSessionTexts;
}

/** What the list and one session both say about a run. */
interface ConversationSessionIdentity {
  sessionId: string;
  startedAt: string;
  status: SessionStatus;
}

/** Enough to choose a run: the start of each text, and how long the whole of it is. */
export interface ConversationSessionRow extends ConversationSessionIdentity {
  /** Cut at SESSION_PREVIEW_MAX_CHARS; absent when the session recorded no user message. */
  userInput?: string;
  /** Cut the same way; absent when there is no final answer: it failed, was stopped, or is still running. */
  agentResponse?: string;
  /** Characters in the whole user message, which `getConversationSession` returns. */
  userInputChars?: number;
  agentResponseChars?: number;
}

/** One run in full: both texts uncut, and what the run cost. The sizes stay on the list. */
export interface ConversationSessionDetail extends ConversationSessionIdentity {
  error?: RunErrorRecord;
  origin: SessionOrigin;
  models: string[];
  inputTokensUncached: number;
  inputTokensCacheRead: number;
  outputTokensTotal: number;
  /** Tool calls in the session, failed ones included: how many `calls.ts` lists for it. */
  callCount: number;
  costByCurrency: Partial<Record<Currency, number>>;
  userInput?: string;
  agentResponse?: string;
}

function identity(session: LightSession): ConversationSessionIdentity {
  return { sessionId: session.sessionId, startedAt: session.timestamp, status: session.status };
}

function toRow(session: LightSession, text: SessionTextRecord | undefined): ConversationSessionRow {
  return {
    ...identity(session),
    ...(text?.userInput !== undefined ? { userInput: preview(text.userInput) } : {}),
    ...(text?.agentResponse !== undefined ? { agentResponse: preview(text.agentResponse) } : {}),
    ...(text?.userInput !== undefined ? { userInputChars: countChars(text.userInput) } : {}),
    ...(text?.agentResponse !== undefined ? { agentResponseChars: countChars(text.agentResponse) } : {}),
  };
}

function toDetail(session: LightSession, text: SessionTextRecord | undefined): ConversationSessionDetail {
  return {
    ...identity(session),
    ...(session.error ? { error: session.error } : {}),
    origin: session.origin,
    models: session.models,
    inputTokensUncached: uncachedInputTokens(session.inputTokensTotal, session.inputTokensCacheRead),
    inputTokensCacheRead: session.inputTokensCacheRead,
    outputTokensTotal: session.outputTokensTotal,
    callCount: session.toolTotal,
    costByCurrency: session.costByCurrency,
    ...(text?.userInput !== undefined ? { userInput: text.userInput } : {}),
    ...(text?.agentResponse !== undefined ? { agentResponse: text.agentResponse } : {}),
  };
}

/** Cut on whole characters, so an emoji at the edge is kept or dropped, never split. */
function preview(text: string): string {
  if (text.length <= SESSION_PREVIEW_MAX_CHARS) return text;
  return Array.from(text).slice(0, SESSION_PREVIEW_MAX_CHARS).join("");
}

/** Newest run first; null when the workspace does not exist. */
function readSessions(
  workspaceId: string,
  conversationId: string,
  deps: ConversationSessionsDeps,
  sessionId?: string,
): Array<{ session: LightSession; text?: SessionTextRecord }> | null {
  if (!(deps.workspaces ?? getStore()).getWorkspace(workspaceId)) return null;
  if (!(deps.conversations ?? conversations).getMeta(workspaceId, conversationId)) {
    throw new ConversationNotFoundError(conversationId);
  }
  const sessions = groupBySessions((deps.usage ?? listUsageLight)(workspaceId, conversationId, sessionId));
  const texts = new Map(
    (deps.texts ?? listSessionTexts)(workspaceId, conversationId, sessionId).map((text) => [text.sessionId, text]),
  );
  return sessions.map((session) => ({ session, text: texts.get(session.sessionId) }));
}

/** Newest run first; null when the workspace does not exist. */
export function listConversationSessions(
  workspaceId: string,
  conversationId: string,
  deps: ConversationSessionsDeps = {},
): { sessions: ConversationSessionRow[] } | null {
  const sessions = readSessions(workspaceId, conversationId, deps);
  return sessions && { sessions: sessions.map(({ session, text }) => toRow(session, text)) };
}

/** One run of the conversation in full; null when the workspace does not exist. */
export function getConversationSession(
  workspaceId: string,
  conversationId: string,
  sessionId: string,
  deps: ConversationSessionsDeps = {},
): { session: ConversationSessionDetail } | null {
  const sessions = readSessions(workspaceId, conversationId, deps, sessionId);
  if (!sessions) return null;
  const [found] = sessions;
  if (!found) throw new SessionNotFoundError(sessionId);
  return { session: toDetail(found.session, found.text) };
}
