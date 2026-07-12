// Disk-backed registry of a workspace's conversations. Each workspace holds several
// conversations the user can switch between; each conversation owns its own message history.
//
// Layout (sibling to the workspace registry, keyed by stable workspace id so it is unaffected by
// renames and never mounted into the agent's container or shown in the file tree):
//
//   WORKSPACES_ROOT/.conversations/<workspaceId>/
//       index.json            ConversationMeta[], newest-first
//       <conversationId>.json { id, meta, messages: StoredMessage[] }
//
// History is loaded lazily and held in memory; the runner mutates the live BaseMessage[] in place,
// and persist() snapshots it to disk (called by the run broker at run end). Persisting only at run
// end keeps the on-disk history and the in-flight event buffer non-overlapping, which is what makes
// live reconnect reconstruct cleanly (see runBroker.ts).
import path from "path";
import { readFileSync, existsSync, rmSync } from "fs";
import type { BaseMessage, StoredMessage } from "@langchain/core/messages";
import { atomicSaveJson } from "../infra/jsonPersist";
import { WORKSPACES_ROOT } from "../infra/paths";
import { createLogger } from "../infra/logger";
import { serializeMessages, deserializeMessages } from "../agent/messageSerialization";
import { broadcastToWorkspace } from "../infra/realtime/wsHub";

const log = createLogger("conversations");

export interface ConversationMeta {
  id: string;
  title: string;
  /** "skill-call" marks a conversation created by an agent-to-agent call_agent invocation;
   *  "scheduled" marks one started automatically by a workspace schedule (vs the default
   *  user-initiated chat). Stored as provenance metadata for API/UI consumers. */
  kind?: "user" | "skill-call" | "scheduled";
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

interface ConversationFile {
  id: string;
  meta: ConversationMeta;
  messages: StoredMessage[];
}

interface WorkspaceConversations {
  loaded: boolean;
  metas: ConversationMeta[]; // newest-first
  activeId: string | null;
  messages: Map<string, BaseMessage[]>; // convId -> live history (lazy)
}


// Singleton shared across the custom server and the webpack-bundled API routes (same rationale as
// wsHub/workspaceStore): without it each module instance would keep a divergent view.
const g = global as typeof global & { _conversations?: Map<string, WorkspaceConversations> };
if (!g._conversations) g._conversations = new Map();
const store = g._conversations;

function convDir(workspaceId: string): string {
  return path.join(WORKSPACES_ROOT, ".conversations", workspaceId);
}
function indexPath(workspaceId: string): string {
  return path.join(convDir(workspaceId), "index.json");
}
function filePath(workspaceId: string, convId: string): string {
  return path.join(convDir(workspaceId), `${convId}.json`);
}

function state(workspaceId: string): WorkspaceConversations {
  let s = store.get(workspaceId);
  if (!s) {
    s = { loaded: false, metas: [], activeId: null, messages: new Map() };
    store.set(workspaceId, s);
  }
  return s;
}

// Reads index.json from disk once per process. Idempotent.
function ensureLoaded(workspaceId: string): WorkspaceConversations {
  const s = state(workspaceId);
  if (s.loaded) return s;
  try {
    const raw = readFileSync(indexPath(workspaceId), "utf-8");
    s.metas = JSON.parse(raw) as ConversationMeta[];
  } catch {
    s.metas = [];
  }
  s.activeId = s.metas[0]?.id ?? null;
  s.loaded = true;
  return s;
}

function saveIndex(workspaceId: string, s: WorkspaceConversations): void {
  atomicSaveJson(indexPath(workspaceId), s.metas);
}

function notifyConversationsChanged(workspaceId: string): void {
  try {
    broadcastToWorkspace(workspaceId, JSON.stringify({ type: "conversations_changed" }));
  } catch {
    // Best-effort UI hint only: failures must never affect conversation persistence.
  }
}


/** Called on first WebSocket connect so a returning user immediately sees prior conversations. */
export function loadIndex(workspaceId: string): ConversationMeta[] {
  return ensureLoaded(workspaceId).metas;
}

export function listConversations(workspaceId: string): ConversationMeta[] {
  return ensureLoaded(workspaceId).metas;
}

export function getActiveId(workspaceId: string): string {
  const s = ensureLoaded(workspaceId);
  if (s.activeId && s.metas.some((m) => m.id === s.activeId)) return s.activeId;
  if (s.metas.length > 0) {
    s.activeId = s.metas[0].id;
    return s.activeId;
  }
  return createConversation(workspaceId).id;
}

export function setActiveId(workspaceId: string, convId: string): void {
  const s = ensureLoaded(workspaceId);
  if (s.metas.some((m) => m.id === convId)) s.activeId = convId;
}

export function createConversation(
  workspaceId: string,
  opts?: { title?: string; kind?: ConversationMeta["kind"] },
): ConversationMeta {
  const s = ensureLoaded(workspaceId);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const meta: ConversationMeta = {
    id,
    title: opts?.title ?? id.slice(0, 8), // default: short, stable id label; never rewritten
    ...(opts?.kind ? { kind: opts.kind } : {}),
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  };
  s.metas.unshift(meta);
  s.activeId = meta.id;
  s.messages.set(meta.id, []);
  saveIndex(workspaceId, s);
  atomicSaveJson(filePath(workspaceId, meta.id), { id: meta.id, meta, messages: [] } as ConversationFile);
  log.info({ workspaceId, conversationId: meta.id }, "conversation created");
  notifyConversationsChanged(workspaceId);
  return meta;
}

/**
 * Live message history for a conversation, loaded lazily from disk and cached. The returned array
 * is the very array the runner appends to — callers must not replace it, only mutate in place.
 * Returns null if the conversation does not exist.
 */
export function getMessages(workspaceId: string, convId: string): BaseMessage[] | null {
  const s = ensureLoaded(workspaceId);
  if (!s.metas.some((m) => m.id === convId)) return null;
  let msgs = s.messages.get(convId);
  if (!msgs) {
    try {
      const raw = readFileSync(filePath(workspaceId, convId), "utf-8");
      const file = JSON.parse(raw) as ConversationFile;
      msgs = deserializeMessages(file.messages ?? []);
    } catch {
      msgs = [];
    }
    s.messages.set(convId, msgs);
  }
  return msgs;
}

/**
 * The last-persisted (on-disk) history for a conversation, read fresh from disk and NOT cached.
 * Unlike getMessages, this never reflects an in-flight run: the runner mutates the live in-memory
 * array (appending the user turn at run start), but persist() only snapshots to disk at run end.
 * Callers rendering the "persisted transcript" of a possibly-running conversation must use this so
 * the in-flight user turn isn't double-counted against the client's live `userInput` echo.
 * Returns null if the conversation does not exist.
 */
export function getPersistedMessages(workspaceId: string, convId: string): BaseMessage[] | null {
  const s = ensureLoaded(workspaceId);
  if (!s.metas.some((m) => m.id === convId)) return null;
  try {
    const raw = readFileSync(filePath(workspaceId, convId), "utf-8");
    const file = JSON.parse(raw) as ConversationFile;
    return deserializeMessages(file.messages ?? []);
  } catch {
    return [];
  }
}

export function getMeta(workspaceId: string, convId: string): ConversationMeta | undefined {
  return ensureLoaded(workspaceId).metas.find((m) => m.id === convId);
}

/** Snapshot a conversation's in-memory history to disk and refresh its index entry. */
export function persist(workspaceId: string, convId: string): void {
  const s = ensureLoaded(workspaceId);
  const meta = s.metas.find((m) => m.id === convId);
  const msgs = s.messages.get(convId);
  if (!meta || !msgs) return;

  const now = new Date().toISOString();
  meta.updatedAt = now;
  meta.lastMessageAt = now;
  // Title is a fixed short id set at creation — intentionally never rewritten here.
  // Bubble the just-touched conversation to the top of the switcher.
  s.metas = [meta, ...s.metas.filter((m) => m.id !== convId)];

  try {
    atomicSaveJson(filePath(workspaceId, convId), {
      id: convId,
      meta,
      messages: serializeMessages(msgs),
    } as ConversationFile);
    saveIndex(workspaceId, s);
    notifyConversationsChanged(workspaceId);
  } catch (err) {
    log.error({ err, workspaceId, convId }, "failed to persist conversation");
  }
}

/** Remove all on-disk and in-memory state for a workspace's conversations (on workspace delete). */
export function deleteWorkspaceConversations(workspaceId: string): void {
  store.delete(workspaceId);
  try {
    const dir = convDir(workspaceId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, workspaceId }, "failed to delete conversation dir");
  }
}
