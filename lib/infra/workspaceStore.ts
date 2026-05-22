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
import type { BaseMessage } from "@langchain/core/messages";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { removeContainer } from "./containerManager";

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

const workspaces = new Map<string, Workspace>();

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
    // First run or registry not yet created — start fresh
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

loadRegistry();

export async function createWorkspace(name: string): Promise<Workspace> {
  const id = crypto.randomUUID();
  const dir = path.join(WORKSPACES_ROOT, name);
  await fsAsync.mkdir(dir, { recursive: true });

  const now = new Date().toISOString().slice(0, 19);

  const agentsMdPath = path.join(dir, "AGENTS.md");
  await fsAsync.writeFile(
    agentsMdPath,
    `# Workspace Instructions

This is the master instructions file for the workspace agent.
Add your project-specific rules, conventions, and context here.
The agent will follow these instructions on every request.
`,
    "utf8"
  );
  await fsAsync.chmod(agentsMdPath, 0o444);

  await Promise.all([
    fsAsync.writeFile(
      path.join(dir, "state.md"),
      `# ${name} — State Log

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
  saveRegistry();
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

export function renameWorkspace(id: string, name: string): boolean {
  const ws = workspaces.get(id);
  if (!ws) return false;
  ws.name = name.trim();
  saveRegistry();
  return true;
}

export async function deleteWorkspace(id: string): Promise<boolean> {
  const ws = workspaces.get(id);
  if (!ws) return false;
  workspaces.delete(id);
  saveRegistry();
  await Promise.all([
    removeContainer(id),
    fsAsync.rm(ws.dir, { recursive: true, force: true }),
  ]);
  return true;
}

export function resetWorkspaceMessages(id: string): void {
  const ws = workspaces.get(id);
  if (!ws) return;
  ws.messages = [buildSystemPrompt(ws.dir)];
}
