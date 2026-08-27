// SQLite-backed registry of a workspace's conversations. Each workspace holds several
// conversations the user can switch between; each conversation owns its replayable message state.
//
// History is loaded lazily and held in memory; the runner mutates the live BaseMessage[] in place,
// and persist() snapshots it to SQLite (called by the run broker at run end). Persisting only at
// run end keeps the committed history and the in-flight event buffer non-overlapping, which is
// what makes live reconnect reconstruct cleanly (see runBroker.ts).
import type Database from "better-sqlite3";
import type { BaseMessage, StoredMessage } from "@langchain/core/messages";
import { createLogger } from "../infra/logger";
import { serializeMessages, deserializeMessages } from "../agent/messageSerialization";
import { appDataDb as db, invalidateAppDataDb } from "../data/database";
import { broadcastToWorkspace } from "../infra/realtime/wsHub";

const log = createLogger("conversations");

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
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

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  messages_json?: string;
}

function rowToMeta(row: ConversationRow): ConversationMeta {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

function insertConversation(
  conn: Database.Database,
  workspaceId: string,
  meta: ConversationMeta,
  messages: StoredMessage[],
): void {
  conn
    .prepare(
      `
        INSERT INTO conversations (
          workspace_id, id, title, created_at, updated_at, last_message_at, messages_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      workspaceId,
      meta.id,
      meta.title,
      meta.createdAt,
      meta.updatedAt,
      meta.lastMessageAt,
      JSON.stringify(messages),
    );
}

function state(workspaceId: string): WorkspaceConversations {
  let s = store.get(workspaceId);
  if (!s) {
    s = { loaded: false, metas: [], activeId: null, messages: new Map() };
    store.set(workspaceId, s);
  }
  return s;
}

// Reads conversation metadata from SQLite once per process. Idempotent.
function ensureLoaded(workspaceId: string): WorkspaceConversations {
  const s = state(workspaceId);
  if (s.loaded) return s;
  try {
    const conn = db();
    const rows = conn
      .prepare(
        `
          SELECT id, title, created_at, updated_at, last_message_at
          FROM conversations
          WHERE workspace_id = ?
          ORDER BY last_message_at DESC, updated_at DESC, id DESC
        `,
      )
      .all(workspaceId) as ConversationRow[];
    s.metas = rows.map(rowToMeta);
  } catch (err) {
    log.error(
      {
        event: "conversation_index_load_failed",
        outcome: "empty_index_used",
        err,
        workspaceId,
      },
      "failed to load conversation index",
    );
    s.metas = [];
  }
  s.activeId = s.metas[0]?.id ?? null;
  s.loaded = true;
  return s;
}

function notifyConversationsChanged(workspaceId: string): void {
  try {
    broadcastToWorkspace(workspaceId, JSON.stringify({ type: "conversations_changed" }));
  } catch (err) {
    // Best-effort UI hint only: failures must never affect conversation persistence. Debug level
    // because a disconnected client is routine — it is here only so a UI that has silently stopped
    // refreshing leaves a trail to follow.
    log.debug({ err, workspaceId }, "conversations_changed broadcast failed");
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

export function createConversation(workspaceId: string, opts?: { title?: string }): ConversationMeta {
  const s = ensureLoaded(workspaceId);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const meta: ConversationMeta = {
    id,
    title: opts?.title ?? id.slice(0, 8), // default: short, stable id label; never rewritten
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  };
  insertConversation(db(), workspaceId, meta, []);
  s.metas.unshift(meta);
  s.activeId = meta.id;
  s.messages.set(meta.id, []);
  log.info({ workspaceId, conversationId: meta.id }, "conversation created");
  notifyConversationsChanged(workspaceId);
  return meta;
}

/**
 * Live message history for a conversation, loaded lazily from SQLite and cached. The returned array
 * is the very array the runner appends to — callers must not replace it, only mutate in place.
 * Returns null if the conversation does not exist.
 */
export function getMessages(workspaceId: string, convId: string): BaseMessage[] | null {
  const s = ensureLoaded(workspaceId);
  if (!s.metas.some((m) => m.id === convId)) return null;
  let msgs = s.messages.get(convId);
  if (!msgs) {
    try {
      const row = db()
        .prepare("SELECT messages_json FROM conversations WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, convId) as { messages_json: string } | undefined;
      msgs = deserializeMessages(row ? (JSON.parse(row.messages_json) as StoredMessage[]) : []);
    } catch (err) {
      log.error(
        {
          event: "conversation_messages_load_failed",
          outcome: "empty_history_used",
          err,
          workspaceId,
          convId,
        },
        "failed to load conversation messages",
      );
      msgs = [];
    }
    s.messages.set(convId, msgs);
  }
  return msgs;
}

/**
 * The last-persisted history for a conversation, read fresh from SQLite and NOT cached.
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
    const row = db()
      .prepare("SELECT messages_json FROM conversations WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, convId) as { messages_json: string } | undefined;
    return deserializeMessages(row ? (JSON.parse(row.messages_json) as StoredMessage[]) : []);
  } catch (err) {
    log.error(
      {
        event: "persisted_conversation_load_failed",
        outcome: "empty_history_used",
        err,
        workspaceId,
        convId,
      },
      "failed to load persisted conversation messages",
    );
    return [];
  }
}

export function getMeta(workspaceId: string, convId: string): ConversationMeta | undefined {
  return ensureLoaded(workspaceId).metas.find((m) => m.id === convId);
}

/** Snapshot a conversation's in-memory history to SQLite and refresh its metadata atomically. */
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
    db()
      .prepare(
        `
          UPDATE conversations
          SET title = ?, updated_at = ?, last_message_at = ?, messages_json = ?
          WHERE workspace_id = ? AND id = ?
        `,
      )
      .run(
        meta.title,
        meta.updatedAt,
        meta.lastMessageAt,
        JSON.stringify(serializeMessages(msgs)),
        workspaceId,
        convId,
      );
    notifyConversationsChanged(workspaceId);
  } catch (err) {
    invalidateAppDataDb();
    log.error(
      {
        event: "conversation_persist_failed",
        outcome: "conversation_not_persisted",
        err,
        workspaceId,
        convId,
      },
      "failed to persist conversation",
    );
  }
}

/** Remove all replay state for a workspace without touching its execution records. */
export function deleteWorkspaceConversations(workspaceId: string): void {
  store.delete(workspaceId);
  try {
    db().prepare("DELETE FROM conversations WHERE workspace_id = ?").run(workspaceId);
  } catch (err) {
    log.warn({ err, workspaceId }, "failed to delete workspace conversations");
  }
}
