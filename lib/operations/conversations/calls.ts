// A session's tool calls, sizes only, or one call with its input and output in full. Read-only like
// ./sessions.ts: the list says what each call costs to read, so a caller opens only the ones worth it.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import * as conversations from "@/lib/conversations/store";
import { CallNotFoundError, ConversationNotFoundError, SessionNotFoundError } from "@/lib/operations/agent/errors";
import { listSessionToolCalls } from "@/lib/usage/queries";
import type { SessionToolCallRecord, ToolStatus } from "@/lib/usage/types";

export interface SessionCallsDeps {
  workspaces?: Pick<IWorkspaceStore, "getWorkspace">;
  conversations?: Pick<typeof conversations, "getMeta">;
  calls?: typeof listSessionToolCalls;
}

/** What the list and one call both say about a call. */
interface SessionCallIdentity {
  callId: string;
  /** When the model call that requested it was recorded; calls requested together share one. */
  timestamp: string;
  tool: string;
  status: ToolStatus;
}

/** One call without its texts, only what each would cost to read. */
export interface SessionCallRow extends SessionCallIdentity {
  /** The size of the arguments as JSON text. */
  inputChars: number;
  outputChars: number;
}

/** One call with both texts, uncut: the runner already bounds what a tool may return. */
export interface SessionCallDetail extends SessionCallIdentity {
  /** The call's arguments as the agent gave them. */
  input: Record<string, unknown>;
  output: string;
}

function identity(call: SessionToolCallRecord): SessionCallIdentity {
  return { callId: call.id, timestamp: call.timestamp, tool: call.name, status: call.status };
}

/** Whole characters, not UTF-16 units, so an emoji counts once. */
export function countChars(text: string): number {
  return Array.from(text).length;
}

function toRow(call: SessionToolCallRecord): SessionCallRow {
  return {
    ...identity(call),
    inputChars: countChars(JSON.stringify(call.args)),
    outputChars: countChars(call.output),
  };
}

/** Oldest call first; null when the workspace does not exist. */
function readCalls(
  workspaceId: string,
  conversationId: string,
  sessionId: string,
  deps: SessionCallsDeps,
): SessionToolCallRecord[] | null {
  if (!(deps.workspaces ?? getStore()).getWorkspace(workspaceId)) return null;
  if (!(deps.conversations ?? conversations).getMeta(workspaceId, conversationId)) {
    throw new ConversationNotFoundError(conversationId);
  }
  const calls = (deps.calls ?? listSessionToolCalls)(workspaceId, conversationId, sessionId);
  if (!calls) throw new SessionNotFoundError(sessionId);
  return calls;
}

/** Every call of the session in execution order, without input or output text. */
export function listConversationSessionCalls(
  workspaceId: string,
  conversationId: string,
  sessionId: string,
  deps: SessionCallsDeps = {},
): { calls: SessionCallRow[] } | null {
  const calls = readCalls(workspaceId, conversationId, sessionId, deps);
  return calls && { calls: calls.map(toRow) };
}

/** One call of the session with its input and output; the sizes stay on the list. */
export function getConversationSessionCall(
  workspaceId: string,
  conversationId: string,
  sessionId: string,
  callId: string,
  deps: SessionCallsDeps = {},
): { call: SessionCallDetail } | null {
  const calls = readCalls(workspaceId, conversationId, sessionId, deps);
  if (!calls) return null;
  const call = calls.find((candidate) => candidate.id === callId);
  if (!call) throw new CallNotFoundError(callId);
  return { call: { ...identity(call), input: call.args, output: call.output } };
}
