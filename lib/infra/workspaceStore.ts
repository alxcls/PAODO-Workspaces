// In-memory registry of all workspaces, backed by a JSON file for persistence across restarts.
// Each workspace has an isolated directory on disk and its own conversation message history.
// Provides CRUD operations used by the API routes and agent runner.
//
// NOTE — conversation history is intentionally not persisted to disk. The `messages` array on
// each Workspace lives only in the in-memory Map and resets on server restart or when the user
// disconnects (server.ts calls resetWorkspaceMessages when the last WebSocket closes).
// Workspace files (AGENTS.md, scripts, data) are the intended long-term memory layer for agents.
import path from "path";
import fs from "fs";
import fsAsync from "fs/promises";
import { createLogger } from "./logger";

const log = createLogger("store");
import type { BaseMessage } from "@langchain/core/messages";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { removeContainer, deleteWorkspaceDir } from "./containerManager";
import { getGlobalLock, setPermission } from "./permissionStore";

export interface Workspace {
  id: string;
  name: string;
  dir: string;
  messages: BaseMessage[];
  createdAt: Date;
  maxIterations: number;
}

interface WorkspaceRecord {
  id: string;
  name: string;
  dir?: string;
  createdAt: string;
  maxIterations?: number;
}

export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");

const REGISTRY_FILE = path.join(WORKSPACES_ROOT, ".workspaces.json");

// Shared across the custom server and Next.js API route module instances (same pattern as wsHub.ts).
// Without this, server.ts and the webpack-bundled API routes each get their own Map, so a workspace
// created via the API is invisible to the WS handler until the server restarts.
const g = global as typeof global & { _workspaces?: Map<string, Workspace> };
const freshMap = !g._workspaces;
if (!g._workspaces) g._workspaces = new Map();
const workspaces = g._workspaces;

function assertSafeWorkspaceName(name: string): void {
  const dir = path.join(WORKSPACES_ROOT, name);
  if (!dir.startsWith(WORKSPACES_ROOT + path.sep)) {
    throw new Error(`Invalid workspace name: "${name}"`);
  }
}

function loadRegistry(): void {
  try {
    const records: WorkspaceRecord[] = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    for (const r of records) {
      try {
        assertSafeWorkspaceName(r.name);
      } catch {
        log.warn({ name: r.name, id: r.id }, "skipping poisoned registry entry");
        continue;
      }
      const dir = path.join(WORKSPACES_ROOT, r.name);
      workspaces.set(r.id, {
        id: r.id,
        name: r.name,
        dir,
        messages: [buildSystemPrompt(dir)],
        createdAt: new Date(r.createdAt),
        maxIterations: r.maxIterations ?? 30,
      });
    }
  } catch {
    log.debug("workspace registry not found — starting fresh");
  }
}

function saveRegistry(): void {
  fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });
  const records: WorkspaceRecord[] = Array.from(workspaces.values()).map((w) => ({
    id: w.id,
    name: w.name,
    createdAt: w.createdAt.toISOString(),
    maxIterations: w.maxIterations,
  }));
  const tmp = REGISTRY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, REGISTRY_FILE);
}

if (freshMap) loadRegistry();

export async function createWorkspace(name: string): Promise<Workspace> {
  assertSafeWorkspaceName(name);
  const id = crypto.randomUUID();
  log.info({ name }, "creating workspace");
  const dir = path.join(WORKSPACES_ROOT, name);
  await fsAsync.mkdir(dir, { recursive: true });

  await fsAsync.writeFile(
    path.join(dir, "AGENTS.md"),
    `# Workspace Instructions

This is the master instructions file for the workspace agent.
Add your project-specific rules, conventions, and context here.
The agent will follow these instructions on every request.
`,
    "utf8"
  );
  await setPermission(id, "AGENTS.md", "R");

  const workspace: Workspace = {
    id,
    name,
    dir,
    messages: [buildSystemPrompt(dir)],
    createdAt: new Date(),
    maxIterations: 30,
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
  assertSafeWorkspaceName(trimmed);
  const newDir = path.join(WORKSPACES_ROOT, trimmed);
  try {
    if (ws.dir !== newDir) {
      await fsAsync.rename(ws.dir, newDir);
      ws.dir = newDir;
      ws.messages = [buildSystemPrompt(newDir)];
      // Container bind mount is baked in at creation time — must recreate it with the new path.
      await removeContainer(id);
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
      deleteWorkspaceDir(ws.dir),
      fsAsync.rm(path.join(WORKSPACES_ROOT, ".agent-permissions", `${id}.json`), { force: true }),
    ]);
  } catch (err) {
    log.error({ err, id, dir: ws.dir }, "failed to remove workspace files or container");
    throw err;
  }
  return true;
}

export function setWorkspaceMaxIterations(id: string, n: number): boolean {
  const ws = workspaces.get(id);
  if (!ws) return false;
  ws.maxIterations = n;
  saveRegistry();
  return true;
}

export async function resetWorkspaceMessages(id: string): Promise<void> {
  const ws = workspaces.get(id);
  if (!ws) return;
  const isLocked = await getGlobalLock(id);
  ws.messages = [buildSystemPrompt(ws.dir, isLocked)];
}
