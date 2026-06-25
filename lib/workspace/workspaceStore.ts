// Registry of all workspaces. Each workspace has an isolated directory on disk. Exposed two ways:
//   - the `WorkspaceStore` class (injectable map + persistence) for tests / isolated use
//   - a default singleton + thin free-function exports (back-compat) used in production
//
// NOTE — conversation history lives in conversationStore.ts, persisted to disk per workspace and
// surviving across restarts/disconnects. A workspace no longer carries any message history.
import path from "path";
import { readFileSync } from "fs";
import fsAsync from "fs/promises";
import { createLogger } from "../infra/logger";
import { atomicSaveJson } from "../infra/jsonPersist";
import { scaffoldWorkspaceDir } from "./workspaceScaffold";
import { defaultWorkspaceVersioning } from "../infra/git";
import { WORKSPACES_ROOT } from "../infra/paths";
import { deleteWorkspaceConversations } from "./conversationStore";
import type { IWorkspaceStore } from "../infra/interfaces";
export { WORKSPACES_ROOT };

const log = createLogger("store");


export interface WorkspaceMetadata {
  id: string;
  name: string;
  dir: string;
  createdAt: Date;
  maxIterations: number;
}

export type Workspace = WorkspaceMetadata;

interface WorkspaceRecord {
  id: string;
  name: string;
  dir?: string;
  createdAt: string;
  maxIterations?: number;
}

const REGISTRY_FILE = path.join(WORKSPACES_ROOT, ".workspaces.json");

function assertSafeWorkspaceName(name: string): void {
  const dir = path.join(WORKSPACES_ROOT, name);
  if (!dir.startsWith(WORKSPACES_ROOT + path.sep)) {
    throw new Error(`Invalid workspace name: "${name}"`);
  }
}

type PersistFn = (records: WorkspaceRecord[]) => void;
type LoadFn = () => WorkspaceRecord[] | null;

export interface WorkspaceStoreOptions {
  /** Backing map. Defaults to a fresh Map. The production singleton injects the global map. */
  map?: Map<string, Workspace>;
  /** Persist the registry. Defaults to a no-op (tests). The production singleton writes JSON. */
  persist?: PersistFn;
  /** Load initial records at construction. Defaults to none (tests). */
  load?: LoadFn;
  /**
   * Start the workspace's versioning repo on creation. Defaults to a no-op (tests). The production
   * singleton wires this to the versioning service. Injected (rather than imported) to keep this
   * leaf module free of the services-layer import cycle.
   */
  initRepo?: (workspaceId: string, workspaceDir: string) => Promise<void>;
}

export class WorkspaceStore implements IWorkspaceStore {
  private workspaces: Map<string, Workspace>;
  private persistFn: PersistFn;
  private initRepoFn: (workspaceId: string, workspaceDir: string) => Promise<void>;

  constructor(opts: WorkspaceStoreOptions = {}) {
    this.workspaces = opts.map ?? new Map();
    this.persistFn = opts.persist ?? (() => {});
    this.initRepoFn = opts.initRepo ?? (async () => {});
    const records = (opts.load ?? (() => null))();
    if (records) this.hydrate(records);
  }

  // Populates the map from persisted records, skipping any with an unsafe (poisoned) name.
  private hydrate(records: WorkspaceRecord[]): void {
    for (const r of records) {
      try {
        assertSafeWorkspaceName(r.name);
      } catch {
        log.warn({ name: r.name, id: r.id }, "skipping poisoned registry entry");
        continue;
      }
      const dir = path.join(WORKSPACES_ROOT, r.name);
      this.workspaces.set(r.id, {
        id: r.id,
        name: r.name,
        dir,
        createdAt: new Date(r.createdAt),
        maxIterations: r.maxIterations ?? 30,
      });
    }
  }

  private save(): void {
    const records: WorkspaceRecord[] = Array.from(this.workspaces.values()).map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      maxIterations: w.maxIterations,
    }));
    this.persistFn(records);
  }

  async createWorkspace(name: string): Promise<Workspace> {
    assertSafeWorkspaceName(name);
    const id = crypto.randomUUID();
    log.info({ name }, "creating workspace");
    const dir = path.join(WORKSPACES_ROOT, name);
    await scaffoldWorkspaceDir(dir);

    // Start the versioning repo over the scaffolded files. Best-effort: a missing git binary (or
    // any git failure) must not block workspace creation — versioning is strictly additive.
    try {
      await this.initRepoFn(id, dir);
    } catch (err) {
      log.warn({ err, id, name }, "versioning initRepo failed; workspace created without it");
    }

    const workspace: Workspace = {
      id,
      name,
      dir,
      createdAt: new Date(),
      maxIterations: 30,
    };

    this.workspaces.set(id, workspace);
    try {
      this.save();
    } catch (err) {
      log.error({ err, id, name }, "failed to save registry after createWorkspace");
      throw err;
    }
    return workspace;
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  getWorkspaceByName(name: string): Workspace | undefined {
    return [...this.workspaces.values()].find((w) => w.name === name);
  }

  listWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  async renameWorkspace(id: string, name: string): Promise<boolean> {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    const trimmed = name.trim();
    assertSafeWorkspaceName(trimmed);
    const newDir = path.join(WORKSPACES_ROOT, trimmed);
    try {
      if (ws.dir !== newDir) {
        await fsAsync.rename(ws.dir, newDir);
        ws.dir = newDir;
        // Conversations are keyed by the stable workspace id and stored outside the workspace dir,
        // so a rename leaves them intact — nothing to reset here.
      }
      ws.name = trimmed;
      this.save();
    } catch (err) {
      log.error({ err, id, name: trimmed }, "failed to rename workspace");
      throw err;
    }
    return true;
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    this.workspaces.delete(id);
    deleteWorkspaceConversations(id);
    try {
      this.save();
    } catch (err) {
      log.error({ err, id }, "failed to save registry after deleteWorkspace");
      throw err;
    }
    return true;
  }

  setWorkspaceMaxIterations(id: string, n: number): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.maxIterations = n;
    this.save();
    return true;
  }

}

// ---- Default production singleton ----
// Shared across the custom server and Next.js API route module instances (same pattern as wsHub.ts).
// Without this, server.ts and the webpack-bundled API routes each get their own Map, so a workspace
// created via the API is invisible to the WS handler until the server restarts.
const g = global as typeof global & { _workspaces?: Map<string, Workspace> };
const freshMap = !g._workspaces;
if (!g._workspaces) g._workspaces = new Map();

function defaultLoad(): WorkspaceRecord[] | null {
  // Only read the registry when this module instance owns a fresh map; otherwise an earlier
  // instance already populated it and re-reading would duplicate/overwrite live workspace state.
  if (!freshMap) return null;
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
  } catch {
    log.debug("workspace registry not found — starting fresh");
    return null;
  }
}

export const defaultWorkspaceStore = new WorkspaceStore({
  map: g._workspaces,
  persist: (records) => atomicSaveJson(REGISTRY_FILE, records),
  load: defaultLoad,
  initRepo: (id, dir) => defaultWorkspaceVersioning.initRepo(id, dir),
});

// Back-compat free-function exports — thin delegations to the default singleton so call sites
// not yet migrated to getStore() keep working unchanged.
export const createWorkspace = (name: string) => defaultWorkspaceStore.createWorkspace(name);
export const getWorkspace = (id: string) => defaultWorkspaceStore.getWorkspace(id);
export const getWorkspaceByName = (name: string) => defaultWorkspaceStore.getWorkspaceByName(name);
export const listWorkspaces = () => defaultWorkspaceStore.listWorkspaces();
export const renameWorkspace = (id: string, name: string) => defaultWorkspaceStore.renameWorkspace(id, name);
export const deleteWorkspace = (id: string) => defaultWorkspaceStore.deleteWorkspace(id);
export const setWorkspaceMaxIterations = (id: string, n: number) => defaultWorkspaceStore.setWorkspaceMaxIterations(id, n);
