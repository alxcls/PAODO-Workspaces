import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

// The shared SQLite path is resolved from WORKSPACES_ROOT at import time.
let root: string;
let conv: typeof import("./store");

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "conv-test-"));
  process.env.WORKSPACES_ROOT = root;
  conv = await import("./store");
});

afterAll(() => {
  const g = global as { _paodoDataDb?: Database.Database; _paodoDataDbFile?: string };
  if (g._paodoDataDb?.open) g._paodoDataDb.close();
  delete g._paodoDataDb;
  delete g._paodoDataDbFile;
  rmSync(root, { recursive: true, force: true });
});

describe("conversationStore", () => {
  it("auto-creates an active conversation when none exist", () => {
    const ws = "ws-auto";
    expect(conv.listConversations(ws)).toEqual([]);
    const id = conv.getActiveId(ws);
    const list = conv.listConversations(ws);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    // Title is a short, stable id slug (8 chars), not derived from message content.
    expect(list[0].title).toBe(id.slice(0, 8));
  });

  it("persists replay state in SQLite and keeps the short stable title", () => {
    const ws = "ws-persist";
    const id = conv.getActiveId(ws);
    const title = conv.getMeta(ws, id)!.title;
    const msgs = conv.getMessages(ws, id)!;
    msgs.push(new HumanMessage("Build me a landing page"));
    msgs.push(new AIMessage("on it"));
    conv.persist(ws, id);

    expect(conv.getMeta(ws, id)!.title).toBe(title);

    const db = new Database(path.join(root, ".paodo.db"), { readonly: true });
    const row = db
      .prepare("SELECT title, messages_json FROM conversations WHERE workspace_id = ? AND id = ?")
      .get(ws, id) as { title: string; messages_json: string };
    db.close();
    expect(JSON.parse(row.messages_json)).toHaveLength(2);
    expect(row.title).toBe(title);
    expect(existsSync(path.join(root, ".conversations", ws))).toBe(false);
  });

  it("supports several conversations and switching the active one", () => {
    const ws = "ws-multi";
    const first = conv.getActiveId(ws);
    const second = conv.createConversation(ws);
    expect(conv.getActiveId(ws)).toBe(second.id); // create makes it active
    conv.setActiveId(ws, first);
    expect(conv.getActiveId(ws)).toBe(first);
    expect(conv.listConversations(ws)).toHaveLength(2);
  });

  it("removes replay state without deleting execution records", () => {
    const ws = "ws-del";
    conv.getActiveId(ws);
    conv.deleteWorkspaceConversations(ws);
    expect(conv.listConversations(ws)).toEqual([]);
    const db = new Database(path.join(root, ".paodo.db"), { readonly: true });
    expect(
      (db.prepare("SELECT count(*) AS count FROM conversations WHERE workspace_id = ?").get(ws) as { count: number })
        .count,
    ).toBe(0);
    db.close();
  });
});
