// In-memory registry of all workspaces, backed by a JSON file for persistence across restarts.
// Each workspace has an isolated directory on disk and its own conversation message history.
// Provides CRUD operations used by the API routes and agent runner.
//
// NOTE — conversation history is intentionally not persisted to disk. The `messages` array on
// each Workspace lives only in the in-memory Map and resets on server restart or when the user
// disconnects (server.ts calls resetWorkspaceMessages when the last WebSocket closes). The
// workspace files and state.md are the intended long-term memory layer for agents.
import path from "path";
import fs from "fs";
import fsAsync from "fs/promises";
import { createLogger } from "./logger";

const log = createLogger("store");
import type { BaseMessage } from "@langchain/core/messages";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { removeContainer } from "./containerManager";
import { getGlobalLock } from "./permissionStore";

export interface Workspace {
  id: string;
  name: string;
  dir: string;
  messages: BaseMessage[];
  createdAt: Date;
}

interface WorkspaceRecord {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
}

export const WORKSPACES_ROOT = path.resolve(process.cwd(), "./data");

const REGISTRY_FILE = path.join(WORKSPACES_ROOT, ".workspaces.json");

// Shared across the custom server and Next.js API route module instances (same pattern as wsHub.ts).
// Without this, server.ts and the webpack-bundled API routes each get their own Map, so a workspace
// created via the API is invisible to the WS handler until the server restarts.
const g = global as typeof global & { _workspaces?: Map<string, Workspace> };
const freshMap = !g._workspaces;
if (!g._workspaces) g._workspaces = new Map();
const workspaces = g._workspaces;

function loadRegistry(): void {
  try {
    const records: WorkspaceRecord[] = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    for (const r of records) {
      workspaces.set(r.id, {
        id: r.id,
        name: r.name,
        dir: r.dir,
        messages: [buildSystemPrompt(r.dir)],
        createdAt: new Date(r.createdAt),
      });
    }
  } catch {
    log.debug("workspace registry not found — starting fresh");
  }
}

// NOTE — no file locking. Concurrent write operations (e.g. two simultaneous createWorkspace
// calls) perform a read-modify-write without coordination and can silently clobber each other.
// This is acceptable for single-user / single-instance deployments. If you need multi-instance
// support, replace the JSON file with a database and serialise writes through a transaction.
function saveRegistry(): void {
  fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });
  const records: WorkspaceRecord[] = Array.from(workspaces.values()).map((w) => ({
    id: w.id,
    name: w.name,
    dir: w.dir,
    createdAt: w.createdAt.toISOString(),
  }));
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(records, null, 2));
}

if (freshMap) loadRegistry();

export async function createWorkspace(name: string): Promise<Workspace> {
  const id = crypto.randomUUID();
  log.info({ name }, "creating workspace");
  const dir = path.join(WORKSPACES_ROOT, name);
  await fsAsync.mkdir(dir, { recursive: true });

  const now = new Date().toISOString().slice(0, 19);

  await Promise.all([
    fsAsync.writeFile(
      path.join(dir, "AGENTS.md"),
      `# Workspace Instructions

This is the master instructions file for the workspace agent.
Add your project-specific rules, conventions, and context here.
The agent will follow these instructions on every request.
`,
      "utf8"
    ),
    fsAsync.writeFile(
      path.join(dir, "state.md"),
      `# State Log

This file is meant for logging actions that happen in this workspace.
We advise creating scripts that append to it whenever something meaningful occurs — the agent reads it as context at the start of each session.

---

${now}  workspace initialized
`,
      "utf8"
    ),
  ]);

  const workspace: Workspace = {
    id,
    name,
    dir,
    messages: [buildSystemPrompt(dir)],
    createdAt: new Date(),
  };

  workspaces.set(id, workspace);
  try {
    saveRegistry();
  } catch (err) {
    log.error({ err, id, name }, "failed to save registry after createWorkspace");
    throw err;
  }
  return workspace;
}

export function getWorkspace(id: string): Workspace | undefined {
  return workspaces.get(id);
}

export function getWorkspaceByName(name: string): Workspace | undefined {
  return [...workspaces.values()].find(w => w.name === name);
}

export function listWorkspaces(): Workspace[] {
  return Array.from(workspaces.values());
}

export async function renameWorkspace(id: string, name: string): Promise<boolean> {
  const ws = workspaces.get(id);
  if (!ws) return false;
  const trimmed = name.trim();
  const newDir = path.join(WORKSPACES_ROOT, trimmed);
  try {
    if (ws.dir !== newDir) {
      await fsAsync.rename(ws.dir, newDir);
      ws.dir = newDir;
      ws.messages = [buildSystemPrompt(newDir)];
    }
    ws.name = trimmed;
    saveRegistry();
  } catch (err) {
    log.error({ err, id, name: trimmed }, "failed to rename workspace");
    throw err;
  }
  return true;
}

export async function deleteWorkspace(id: string): Promise<boolean> {
  const ws = workspaces.get(id);
  if (!ws) return false;
  workspaces.delete(id);
  try {
    saveRegistry();
  } catch (err) {
    log.error({ err, id }, "failed to save registry after deleteWorkspace");
    throw err;
  }
  try {
    await Promise.all([
      removeContainer(id),
      fsAsync.rm(ws.dir, { recursive: true, force: true }),
    ]);
  } catch (err) {
    log.error({ err, id, dir: ws.dir }, "failed to remove workspace files or container");
    throw err;
  }
  return true;
}

export async function resetWorkspaceMessages(id: string): Promise<void> {
  const ws = workspaces.get(id);
  if (!ws) return;
  const isLocked = await getGlobalLock(id, ws.dir);
  ws.messages = [buildSystemPrompt(ws.dir, isLocked)];
}
