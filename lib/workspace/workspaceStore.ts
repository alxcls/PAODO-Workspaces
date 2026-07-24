// Registry of all workspaces. Each workspace has an isolated directory on disk. Exposed two ways:
//   - the `WorkspaceStore` class (injectable map + persistence) for tests / isolated use
//   - a default singleton + thin free-function exports (back-compat) used in production
//
// NOTE — conversation history lives in conversationStore.ts, persisted in SQLite per workspace and
// surviving across restarts/disconnects. A workspace no longer carries any message history.
import path from "path";
import { createLogger } from "../infra/logger";
import { atomicSaveJson, readJson } from "../infra/jsonPersist";
import { scaffoldWorkspaceDir } from "./workspaceScaffold";
import { validateWorkspaceName, normalizeForUniqueness, WorkspaceNameError } from "./workspaceName";
import { defaultWorkspaceVersioning } from "../infra/git";
import { WORKSPACES_ROOT } from "../infra/paths";
import { deleteWorkspaceConversations } from "./conversationStore";
import type { IWorkspaceStore } from "../infra/interfaces";
import type { ReasoningEffort } from "../agent/interfaces";
import { deleteAllForWorkspace } from "../infra/security/workspaceSecretStore";
import { deleteForWorkspace as deleteMcpConfig } from "../infra/security/mcpConfigStore";
import { getCredentialProxy } from "../infra/proxy";
import { DEFAULT_MAX_RUN_MINUTES, normalizeMaxRunMinutes } from "./workspaceLimits";
import { assertWorkspaceRegistryRecords } from "../infra/startupChecks";
export { WORKSPACES_ROOT };

const log = createLogger("store");

export interface WorkspaceMetadata {
  id: string;
  name: string;
  dir: string;
  createdAt: Date;
  maxIterations: number;
  /** Wall-clock limit for one run, including model, tool, validation, and child-agent wait time. */
  maxRunMinutes: number;
  /** Workspace-level context shown in the UI and shared with external MCP clients as instructions. */
  description?: string;
  // Per-workspace LLM selection (chosen in the UI). Undefined when the workspace has never picked —
  // the agent then falls back to DEFAULT_LLM. .env holds only the provider API keys, not the choice.
  llmProvider?: string;
  llmModel?: string;
  reasoningEffort?: ReasoningEffort;
}

export type Workspace = WorkspaceMetadata;

interface WorkspaceRecord {
  id: string;
  name: string;
  dir?: string;
  createdAt: string;
  maxIterations?: number;
  maxRunMinutes?: number;
  description?: string;
  llmProvider?: string;
  llmModel?: string;
  reasoningEffort?: ReasoningEffort;
}

const REGISTRY_FILE = path.join(WORKSPACES_ROOT, ".workspaces.json");

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
  /**
   * Tear down every per-workspace resource owned by other subsystems (conversations, secrets, MCP
   * config, credential-proxy rules…) on deletion. Defaults to a no-op (tests). The production
   * singleton wires the concrete cleanups. Injected — rather than importing those stores here — so
   * this leaf registry stays free of their concrete implementations (DIP) and adding a new
   * per-workspace resource means editing the singleton wiring, not this class (OCP).
   */
  onDelete?: (workspaceId: string) => void | Promise<void>;
  /**
   * Bootstrap a new workspace's on-disk directory. Defaults to the real {@link scaffoldWorkspaceDir}
   * (production and dev). Injected so unit tests can exercise createWorkspace's uniqueness/serialization
   * logic without touching the filesystem.
   */
  scaffold?: (dir: string) => Promise<void>;
}

export class WorkspaceStore implements IWorkspaceStore {
  private workspaces: Map<string, Workspace>;
  private persistFn: PersistFn;
  private initRepoFn: (workspaceId: string, workspaceDir: string) => Promise<void>;
  private onDeleteFn: (workspaceId: string) => void | Promise<void>;
  private scaffoldFn: (dir: string) => Promise<void>;
  // Serializes name-mutating operations (create + rename) so a uniqueness check and the write that
  // relies on it can't be interleaved by a concurrent request — the check-then-act would otherwise
  // race (two identical creates could both pass the check). Nothing else in the repo provides
  // call-level ordering, so we chain here rather than reaching for an async-mutex dependency.
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(opts: WorkspaceStoreOptions = {}) {
    this.workspaces = opts.map ?? new Map();
    this.persistFn = opts.persist ?? (() => {});
    this.initRepoFn = opts.initRepo ?? (async () => {});
    this.onDeleteFn = opts.onDelete ?? (() => {});
    this.scaffoldFn = opts.scaffold ?? scaffoldWorkspaceDir;
    // A hot-reloaded server can reuse workspace objects created by an older module version. Fill
    // the new field in-place so those live objects do not accidentally create a zero-delay timer.
    for (const workspace of this.workspaces.values()) {
      workspace.maxRunMinutes = normalizeMaxRunMinutes(workspace.maxRunMinutes);
    }
    const records = (opts.load ?? (() => null))();
    if (records) this.hydrate(records);
  }

  // Populates the map from persisted records. The on-disk directory is keyed by the immutable id,
  // so a legacy or malformed name can no longer poison a path — names are a display/routing concern
  // only now, and every entry is kept (dropping one would hide a workspace whose id-keyed data is
  // still on disk).
  private hydrate(records: WorkspaceRecord[]): void {
    for (const r of records) {
      const dir = path.join(WORKSPACES_ROOT, r.id);
      this.workspaces.set(r.id, {
        id: r.id,
        name: r.name,
        dir,
        createdAt: new Date(r.createdAt),
        maxIterations: r.maxIterations ?? 30,
        maxRunMinutes: normalizeMaxRunMinutes(r.maxRunMinutes),
        description: r.description,
        llmProvider: r.llmProvider,
        llmModel: r.llmModel,
        reasoningEffort: r.reasoningEffort,
      });
    }
  }

  private save(): void {
    const records: WorkspaceRecord[] = Array.from(this.workspaces.values()).map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      maxIterations: w.maxIterations,
      maxRunMinutes: w.maxRunMinutes,
      description: w.description,
      llmProvider: w.llmProvider,
      llmModel: w.llmModel,
      reasoningEffort: w.reasoningEffort,
    }));
    this.persistFn(records);
  }

  // Configuration mutations update the live object before persisting it. If the registry write
  // fails, callers need to know which operation diverged from disk; a generic request 500 loses
  // that distinction and the next restart will silently restore the previous value.
  private saveUpdate(workspaceId: string, operation: string): void {
    try {
      this.save();
    } catch (err) {
      log.error(
        {
          event: "workspace_registry_save_failed",
          outcome: "workspace_update_in_memory_only",
          err,
          workspaceId,
          operation,
          filePath: REGISTRY_FILE,
        },
        "failed to save workspace registry update",
      );
      throw err;
    }
  }

  // Runs a name-mutating operation as the sole writer at a time. The chain is kept alive regardless
  // of how fn settles (errors are swallowed on the stored tail) so one failed mutation can't poison
  // later ones; the caller still sees fn's real result or rejection.
  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(fn, fn);
    this.mutationChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // Throws WORKSPACE_NAME_CONFLICT if any *other* workspace already uses an equivalent name. Names
  // are compared on their folded key so case- and Unicode-equivalent spellings can't coexist while
  // agent routing is still name-based. Callers must hold the mutation lock.
  private assertNameAvailable(name: string, exceptId?: string): void {
    const key = normalizeForUniqueness(name);
    for (const ws of this.workspaces.values()) {
      if (ws.id !== exceptId && normalizeForUniqueness(ws.name) === key) {
        throw new WorkspaceNameError("WORKSPACE_NAME_CONFLICT", `A workspace named "${name}" already exists.`);
      }
    }
  }

  async createWorkspace(rawName: string): Promise<Workspace> {
    return this.serializeMutation(async () => {
      const name = validateWorkspaceName(rawName);
      this.assertNameAvailable(name);
      const id = crypto.randomUUID();
      log.info({ name }, "creating workspace");
      const dir = path.join(WORKSPACES_ROOT, id);
      await this.scaffoldFn(dir);

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
        maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
      };

      this.workspaces.set(id, workspace);
      try {
        this.save();
      } catch (err) {
        // POST /api/workspaces owns the single detailed create failure record; rethrow here so the
        // caller can return a 500 without duplicating the same persistence exception.
        throw err;
      }
      return workspace;
    });
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  getWorkspaceByName(name: string): Workspace | undefined {
    const all = [...this.workspaces.values()];
    // Exact match first — the fast path, and it disambiguates any legacy pre-uniqueness duplicates
    // hydrate() may have loaded (uniqueness is enforced on create/rename, not on load).
    const exact = all.find((w) => w.name === name);
    if (exact) return exact;
    // Fall back to the folded key so name routing matches the case/Unicode-insensitive uniqueness
    // rule: call_agent("sales") resolves a workspace stored as "Sales". Unambiguous because at most
    // one workspace can share a folded key once uniqueness is enforced.
    const key = normalizeForUniqueness(name);
    return all.find((w) => normalizeForUniqueness(w.name) === key);
  }

  listWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  async renameWorkspace(id: string, rawName: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const ws = this.workspaces.get(id);
      if (!ws) return false;
      const name = validateWorkspaceName(rawName);
      this.assertNameAvailable(name, id);
      // Metadata-only: the directory is keyed by the immutable id, so nothing moves on disk and a
      // running agent's container mount is untouched. Conversations, versioning, and secrets are all
      // id-keyed too, so only the display name changes.
      ws.name = name;
      this.saveUpdate(id, "rename_workspace");
      return true;
    });
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    this.workspaces.delete(id);
    await this.onDeleteFn(id);
    try {
      this.save();
    } catch (err) {
      log.error(
        {
          event: "workspace_registry_delete_persist_failed",
          outcome: "workspace_deleted_in_memory_only",
          err,
          workspaceId: id,
          filePath: REGISTRY_FILE,
        },
        "failed to save registry after workspace deletion",
      );
      throw err;
    }
    return true;
  }

  setWorkspaceMaxIterations(id: string, n: number): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.maxIterations = n;
    this.saveUpdate(id, "set_max_iterations");
    return true;
  }

  setWorkspaceMaxRunMinutes(id: string, minutes: number): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.maxRunMinutes = minutes;
    this.saveUpdate(id, "set_max_run_minutes");
    return true;
  }

  setWorkspaceDescription(id: string, description: string): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.description = description.trim();
    this.saveUpdate(id, "set_description");
    return true;
  }

  setWorkspaceLlm(id: string, sel: { provider: string; model: string; reasoningEffort: ReasoningEffort }): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.llmProvider = sel.provider;
    ws.llmModel = sel.model;
    ws.reasoningEffort = sel.reasoningEffort;
    this.saveUpdate(id, "set_llm");
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
  const records = readJson<unknown>(REGISTRY_FILE, null);
  if (records === null) {
    log.debug("workspace registry not found — starting fresh");
    return null;
  }
  // Production startup independently treats this as fatal. Keeping the import-time loader
  // defensive prevents malformed-but-valid JSON from throwing before server.ts installs its fatal
  // handlers; local development retains the historical empty-registry fallback.
  try {
    assertWorkspaceRegistryRecords(records);
    return records as unknown as WorkspaceRecord[];
  } catch {
    return null;
  }
}

export const defaultWorkspaceStore = new WorkspaceStore({
  map: g._workspaces,
  persist: (records) => atomicSaveJson(REGISTRY_FILE, records),
  load: defaultLoad,
  initRepo: (id, dir) => defaultWorkspaceVersioning.initRepo(id, dir),
  // Cascade deletion to every subsystem that keys resources by workspace id. Wired here — the
  // services-layer boundary that's already allowed to know all of them — rather than inside the
  // store, which stays free of these concrete implementations. Add new per-workspace cleanups here.
  onDelete: (id) => {
    deleteWorkspaceConversations(id);
    deleteAllForWorkspace(id);
    deleteMcpConfig(id);
    getCredentialProxy().clearRules(id);
  },
});

// Back-compat free-function exports — thin delegations to the default singleton so call sites
// not yet migrated to getStore() keep working unchanged.
export const createWorkspace = (name: string) => defaultWorkspaceStore.createWorkspace(name);
export const getWorkspace = (id: string) => defaultWorkspaceStore.getWorkspace(id);
export const getWorkspaceByName = (name: string) => defaultWorkspaceStore.getWorkspaceByName(name);
export const listWorkspaces = () => defaultWorkspaceStore.listWorkspaces();
export const renameWorkspace = (id: string, name: string) => defaultWorkspaceStore.renameWorkspace(id, name);
export const deleteWorkspace = (id: string) => defaultWorkspaceStore.deleteWorkspace(id);
export const setWorkspaceMaxIterations = (id: string, n: number) =>
  defaultWorkspaceStore.setWorkspaceMaxIterations(id, n);
export const setWorkspaceMaxRunMinutes = (id: string, minutes: number) =>
  defaultWorkspaceStore.setWorkspaceMaxRunMinutes(id, minutes);
export const setWorkspaceDescription = (id: string, description: string) =>
  defaultWorkspaceStore.setWorkspaceDescription(id, description);
export const setWorkspaceLlm = (
  id: string,
  sel: { provider: string; model: string; reasoningEffort: ReasoningEffort },
) => defaultWorkspaceStore.setWorkspaceLlm(id, sel);
