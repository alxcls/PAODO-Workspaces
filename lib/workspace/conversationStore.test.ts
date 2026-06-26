import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

// conversationStore resolves its on-disk location from WORKSPACES_ROOT (via paths.ts) at import
// time, so the env must be set before the dynamic import below.
let root: string;
let conv: typeof import("./conversationStore");

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "conv-test-"));
  process.env.WORKSPACES_ROOT = root;
  conv = await import("./conversationStore");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

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

  it("persists messages to disk and keeps the short stable title", () => {
    const ws = "ws-persist";
    const id = conv.getActiveId(ws);
    const title = conv.getMeta(ws, id)!.title;
    const msgs = conv.getMessages(ws, id)!;
    msgs.push(new HumanMessage("Build me a landing page"));
    msgs.push(new AIMessage("on it"));
    conv.persist(ws, id);

    expect(conv.getMeta(ws, id)!.title).toBe(title);

    const file = JSON.parse(readFileSync(path.join(root, ".conversations", ws, `${id}.json`), "utf-8"));
    expect(file.messages).toHaveLength(2);
    expect(file.meta.title).toBe(title);
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

  it("removes all on-disk state when a workspace's conversations are deleted", () => {
    const ws = "ws-del";
    conv.getActiveId(ws);
    expect(existsSync(path.join(root, ".conversations", ws))).toBe(true);
    conv.deleteWorkspaceConversations(ws);
    expect(existsSync(path.join(root, ".conversations", ws))).toBe(false);
    expect(conv.listConversations(ws)).toEqual([]);
  });
});
