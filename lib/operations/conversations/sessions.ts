// A conversation's runs, one dashboard row each, or one run with its user message and final answer. Read-only:
// starting or stopping a run is the API's and MCP's job; the grouping is the dashboard's own, so both agree.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import * as conversations from "@/lib/conversations/store";
import type { Currency } from "@/lib/models/currency";
import { ConversationNotFoundError, SessionNotFoundError } from "@/lib/operations/agent/errors";
import { listSessionTexts, listUsageLight } from "@/lib/usage/queries";
import { groupBySessions, type LightSession } from "@/lib/usage/sessions";
import { uncachedInputTokens } from "@/lib/usage/tokenUsage";
import type { RunErrorRecord, SessionOrigin, SessionStatus, SessionTextRecord } from "@/lib/usage/types";

/** The most of each text one session returns; the dashboard's session drawer shows the rest. */
export const SESSION_TEXT_MAX_CHARS = 4000;

export interface ConversationSessionsDeps {
  workspaces?: Pick<IWorkspaceStore, "getWorkspace">;
  conversations?: Pick<typeof conversations, "getMeta">;
  usage?: typeof listUsageLight;
  texts?: typeof listSessionTexts;
}

/** A dashboard row minus what the request already names: the workspace and the conversation. */
export interface ConversationSessionRow {
  sessionId: string;
  status: SessionStatus;
  origin: SessionOrigin;
  models: string[];
  startedAt: string;
  inputTokensUncached: number;
  inputTokensCacheRead: number;
  outputTokensTotal: number;
  toolExec: number;
  costByCurrency: Partial<Record<Currency, number>>;
  error?: RunErrorRecord;
  /** Characters in the user message, the unit `show` cuts at; absent when the session recorded none. */
  userInputChars?: number;
  /** Absent when the session has no final answer: it failed, was stopped, or is still running. */
  agentResponseChars?: number;
}

/** The row, plus each text cut at SESSION_TEXT_MAX_CHARS; `*OmittedChars` says how much was cut. */
export interface ConversationSessionDetail extends ConversationSessionRow {
  userInput?: string;
  userInputOmittedChars?: number;
  agentResponse?: string;
  agentResponseOmittedChars?: number;
}

function toRow(session: LightSession, text: SessionTextRecord | undefined): ConversationSessionRow {
  return {
    sessionId: session.sessionId,
    status: session.status,
    origin: session.origin,
    models: session.models,
    startedAt: session.timestamp,
    inputTokensUncached: uncachedInputTokens(session.inputTokensTotal, session.inputTokensCacheRead),
    inputTokensCacheRead: session.inputTokensCacheRead,
    outputTokensTotal: session.outputTokensTotal,
    toolExec: session.toolTotal,
    costByCurrency: session.costByCurrency,
    ...(session.error ? { error: session.error } : {}),
    ...(text?.userInput !== undefined ? { userInputChars: countChars(text.userInput) } : {}),
    ...(text?.agentResponse !== undefined ? { agentResponseChars: countChars(text.agentResponse) } : {}),
  };
}

/** Whole characters, not UTF-16 units, so an emoji counts once here and in the cut below. */
function countChars(text: string): number {
  return Array.from(text).length;
}

/** Cut on whole characters, so an emoji at the edge is kept or dropped, never split. */
function capText(text: string): { text: string; omittedChars?: number } {
  if (text.length <= SESSION_TEXT_MAX_CHARS) return { text };
  const chars = Array.from(text);
  if (chars.length <= SESSION_TEXT_MAX_CHARS) return { text };
  return { text: chars.slice(0, SESSION_TEXT_MAX_CHARS).join(""), omittedChars: chars.length - SESSION_TEXT_MAX_CHARS };
}

/** Newest run first; null when the workspace does not exist. */
function readSessions(
  workspaceId: string,
  conversationId: string,
  deps: ConversationSessionsDeps,
  sessionId?: string,
): Array<{ row: ConversationSessionRow; text?: SessionTextRecord }> | null {
  if (!(deps.workspaces ?? getStore()).getWorkspace(workspaceId)) return null;
  if (!(deps.conversations ?? conversations).getMeta(workspaceId, conversationId)) {
    throw new ConversationNotFoundError(conversationId);
  }
  const sessions = groupBySessions((deps.usage ?? listUsageLight)(workspaceId, conversationId, sessionId));
  const texts = new Map(
    (deps.texts ?? listSessionTexts)(workspaceId, conversationId, sessionId).map((text) => [text.sessionId, text]),
  );
  return sessions.map((session) => {
    const text = texts.get(session.sessionId);
    return { row: toRow(session, text), text };
  });
}

/** Newest run first; null when the workspace does not exist. */
export function listConversationSessions(
  workspaceId: string,
  conversationId: string,
  deps: ConversationSessionsDeps = {},
): { sessions: ConversationSessionRow[] } | null {
  const sessions = readSessions(workspaceId, conversationId, deps);
  return sessions && { sessions: sessions.map(({ row }) => row) };
}

/** One run of the conversation, the same row `listConversationSessions` gives plus its texts. */
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
  const input = found.text?.userInput === undefined ? undefined : capText(found.text.userInput);
  const answer = found.text?.agentResponse === undefined ? undefined : capText(found.text.agentResponse);
  return {
    session: {
      ...found.row,
      ...(input ? { userInput: input.text } : {}),
      ...(input?.omittedChars ? { userInputOmittedChars: input.omittedChars } : {}),
      ...(answer ? { agentResponse: answer.text } : {}),
      ...(answer?.omittedChars ? { agentResponseOmittedChars: answer.omittedChars } : {}),
    },
  };
}
