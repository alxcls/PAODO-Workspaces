// Registry of all workspaces. Each workspace has an isolated directory on disk. Exposed two ways:
//   - the `WorkspaceStore` class (injectable map + persistence) for tests / isolated use
//   - `defaultWorkspaceStore`, the production singleton, reached through getStore()
//
// NOTE — conversation history lives in lib/conversations/store.ts, persisted in SQLite per workspace and
// surviving across restarts/disconnects. A workspace no longer carries any message history.
import path from "path";
import { createLogger, createAuditLogger } from "../logger";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { scaffoldWorkspaceDir } from "./scaffold";
import { validateWorkspaceName, normalizeForUniqueness, WorkspaceNameError } from "../../workspace/name";
import { defaultWorkspaceVersioning } from "../git";
import { WORKSPACES_ROOT } from "../paths";
import type { IWorkspaceStore } from "../interfaces";
import type { ReasoningEffort } from "../../models/llmSelection";
import { setInternetAccessPolicy } from "../proxy/internetAccessPolicy";
import { DEFAULT_MAX_RUN_MINUTES, normalizeMaxRunMinutes } from "../../workspace/limits";
import type { Workspace } from "../../workspace/types";
import { assertWorkspaceRegistryRecords } from "../startupChecks";
export type { Workspace } from "../../workspace/types";

const log = createLogger("store");
const audit = createAuditLogger("store");

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
  internetAccess?: boolean;
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
        internetAccess: r.internetAccess ?? true,
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
      internetAccess: w.internetAccess,
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
        internetAccess: false,
      };

      this.workspaces.set(id, workspace);
      try {
        this.save();
      } catch (err) {
        // POST /api/workspaces owns the single detailed create failure record; rethrow here so the
        // caller can return a 500 without duplicating the same persistence exception.
        throw err;
      }
      // New workspaces are internet-off by default (see `internetAccess: false` above) — the
      // proxy's sparse policy store must record that immediately, not just on first explicit
      // toggle, or the defense-in-depth layer (internetAccessPolicy.ts) reads "enabled" for a
      // workspace the primary network layer already has fully isolated.
      setInternetAccessPolicy(id, false);
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
    try {
      this.save();
    } catch (err) {
      // Put the workspace back. The in-memory map and the on-disk registry must not disagree: a
      // workspace that vanished from the UI but reappears on restart is harder to reason about than
      // one that never left. The caller surfaces the failure and the delete stays retryable.
      this.workspaces.set(id, ws);
      log.error(
        {
          event: "workspace_registry_delete_persist_failed",
          outcome: "workspace_restored_pending_retry",
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

  setWorkspaceInternetAccess(id: string, enabled: boolean): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.internetAccess = enabled;
    this.saveUpdate(id, "set_internet_access");
    audit.info({ wsId: id, enabled, event: "workspace_internet_access_toggled" }, "internet access toggled");
    return true;
  }

  /**
   * Clear the stored model choice of every workspace pointed at a provider outside `allowed`, and
   * report what was cleared.
   *
   * The workspace half of the withdrawal purgeProviderKeysExcept starts. Switching a provider off
   * destroys its API key, so a workspace still naming it cannot run at all — and nothing said so
   * where the choice is made: the picker rendered the withdrawn provider as an ordinary selection
   * (it is a stored value, not a catalog entry) and the failure only surfaced in the transcript, on
   * send. Clearing the three fields returns the workspace to "never picked", which
   * currentModelSelection already resolves to a provider the deployment does offer — so it runs
   * again without anyone editing it.
   *
   * The withdrawn choice is NOT kept for a later re-enable. The key it depended on is gone for good,
   * and a selection nothing in the app will honour is worse than none; the audit line is what makes
   * the previous provider recoverable afterwards.
   *
   * Takes the allowed list rather than reading .env, for the reason purgeProviderKeysExcept does:
   * which providers exist and which var governs each is the provider registry's knowledge, and that
   * module pulls the LLM SDKs an infra store must not drag in.
   */
  clearWithdrawnLlmSelections(allowed: readonly string[]): Array<{ workspaceId: string; provider: string }> {
    const offered = new Set(allowed);
    const stranded = this.listWorkspaces().filter((ws) => ws.llmProvider && !offered.has(ws.llmProvider));
    if (stranded.length === 0) return [];
    const cleared = stranded.map((ws) => ({ workspaceId: ws.id, provider: ws.llmProvider as string }));
    for (const ws of stranded) {
      ws.llmProvider = undefined;
      ws.llmModel = undefined;
      ws.reasoningEffort = undefined;
    }
    try {
      this.save();
    } catch (err) {
      // Same divergence saveUpdate reports, stated for the batch: the live objects are cleared but
      // disk still names the withdrawn providers. The caller is startup, which refuses to serve on
      // this — so the mismatch never outlives the process.
      log.error(
        {
          event: "workspace_registry_save_failed",
          outcome: "withdrawn_llm_selections_cleared_in_memory_only",
          err,
          operation: "clear_withdrawn_llm_selections",
          workspaceIds: cleared.map((entry) => entry.workspaceId),
          filePath: REGISTRY_FILE,
        },
        "failed to save workspace registry after clearing withdrawn model selections",
      );
      throw err;
    }
    for (const { workspaceId, provider } of cleared) {
      audit.warn(
        {
          event: "workspace_llm_selection_cleared",
          outcome: "model_selection_reset_to_default",
          workspaceId,
          provider,
        },
        "provider withdrawn by configuration — the workspace's model selection was cleared",
      );
    }
    return cleared;
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
});
