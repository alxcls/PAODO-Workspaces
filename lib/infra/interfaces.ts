// Abstractions for the two stateful infra singletons (workspace registry + container
// lifecycle). Consumers depend on these interfaces rather than the concrete singletons so
// that tests and the agent layer can inject isolated instances. Production keeps the
// default singletons via lib/infra/services.ts.
//
// Type-only imports below: erased at compile time, so the apparent cycle with
// workspaceStore.ts (which implements IWorkspaceStore) carries no runtime edge.
import type { Workspace } from "../workspace/workspaceStore";
import type { ReasoningEffort } from "../agent/interfaces";
import type { DockerResult } from "./docker/dockerClient";
import type { BackgroundTask } from "./docker/containerManager";

export interface IWorkspaceStore {
  getWorkspace(id: string): Workspace | undefined;
  getWorkspaceByName(name: string): Workspace | undefined;
  listWorkspaces(): Workspace[];
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: string, name: string): Promise<boolean>;
  deleteWorkspace(id: string): Promise<boolean>;
  setWorkspaceMaxIterations(id: string, n: number): boolean;
  setWorkspaceDescription(id: string, description: string): boolean;
  setWorkspaceLlm(id: string, sel: { provider: string; model: string; reasoningEffort: ReasoningEffort }): boolean;
}

export interface HistoryEntry {
  sha: string;
  message: string;
  /** ISO-8601 commit timestamp. */
  timestamp: string;
  /** True for the snapshot the workspace is currently at (HEAD) — the state shown on disk. */
  current?: boolean;
}

/** One file's churn within a snapshot. add/del are -1 for binary files (git emits "-"). */
export interface VersionFileStat {
  path: string;
  add: number;
  del: number;
}

/** A snapshot enriched with its per-file diffstat vs its parent — feeds the agent's history
 *  overview and (later) a richer UI history view. Structured so each consumer formats its own way. */
export interface VersionStat {
  sha: string;
  /** Git-relative age, e.g. "2 hours ago". */
  age: string;
  subject: string;
  files: VersionFileStat[];
  totalAdd: number;
  totalDel: number;
  /** True for the snapshot the work-tree is currently at (HEAD) — the state on disk. After a UI
   *  restore, HEAD moves, so this marks where the user parked, not necessarily the newest snapshot. */
  current?: boolean;
}

// Per-workspace git versioning. Methods take (workspaceId, workspaceDir): the id keys the
// external git-dir (stable across renames), the dir is the work-tree. See workspaceVersioning.ts.
export interface IWorkspaceVersioning {
  initRepo(workspaceId: string, workspaceDir: string): Promise<void>;
  commitBaseline(workspaceId: string, workspaceDir: string, prompt: string): Promise<{ sha: string }>;
  commitResult(workspaceId: string, workspaceDir: string, summary: string): Promise<{ sha: string; changed: boolean }>;
  history(workspaceId: string, workspaceDir: string): Promise<HistoryEntry[]>;
  diff(workspaceId: string, workspaceDir: string, from: string, to: string): Promise<string>;
  /** Snapshots, newest-first, each with its per-file diffstat vs its parent. Omit `n` to list all. */
  versionStats(workspaceId: string, workspaceDir: string, n?: number): Promise<VersionStat[]>;
  /** Raw diff for one snapshot (`git show sha`), optionally narrowed to one path. */
  versionDiff(workspaceId: string, workspaceDir: string, sha: string, opts?: { path?: string }): Promise<string>;
  restore(workspaceId: string, workspaceDir: string, sha: string): Promise<boolean>;
  /** Permanently remove a workspace's versioning repo. Called when the workspace is deleted. */
  deleteRepo(workspaceId: string): Promise<void>;
  /**
   * Probe that the `git` binary this service shells out to actually exists. Snapshot failures are
   * swallowed at runtime (versioning must never break a run), so a missing binary would otherwise
   * disable version history silently. Returns false if git can't be invoked.
   */
  isGitAvailable(): Promise<boolean>;
}

// The container manager exposes three separable roles. They're split into role interfaces (ISP) so a
// consumer can depend on just the capability it uses — a tool that only kills a background task takes
// IBackgroundTasks, not the whole 12-method surface, and its tests mock three methods instead of
// twelve. The concrete ContainerManager implements all three; IContainerManager is their union, kept
// for the composition root (buildTools) and the services registry, which legitimately wire the lot.

/** Container lifecycle: create/warm, stop, remove, workspace-dir teardown, and the boot-time
 *  credential-proxy reattach. Everything that manages a container's existence, not what runs inside it. */
export interface IContainerLifecycle {
  ensure(workspaceId: string, workspaceDir: string): Promise<void>;
  stop(workspaceId: string): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  reattachProxyNetworks(): Promise<void>;
  deleteWorkspaceDir(workspaceDir: string): Promise<void>;
  assertDockerAvailable(): Promise<void>;
}

/** Foreground command execution inside a workspace container. */
export interface IContainerExec {
  exec(
    workspaceId: string,
    workspaceDir: string,
    cmdArgs: string[],
    opts?: { stdin?: string },
  ): Promise<DockerResult>;
  execStreaming(
    workspaceId: string,
    workspaceDir: string,
    cmdArgs: string[],
    opts: { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void; signal?: AbortSignal },
  ): Promise<{ code: number | null }>;
  execAsRoot(workspaceId: string, workspaceDir: string, cmdArgs: string[]): Promise<DockerResult>;
}

/** Detached, long-lived background processes (dev servers etc.) tracked across turns. */
export interface IBackgroundTasks {
  /** Launch a command detached from the exec kill path (dev servers etc.); returns its taskId + log path. */
  startBackground(workspaceId: string, workspaceDir: string, command: string): Promise<{ taskId: string; logFile: string }>;
  /** Kill a tracked background process by taskId; false if none tracked for the workspace. */
  stopBackground(workspaceId: string, taskId: string): Promise<boolean>;
  /** Running background tasks for a workspace (for context surfacing / management across turns). */
  listBackground(workspaceId: string): BackgroundTask[];
}

/** The full manager surface — the union of the three roles above. */
export interface IContainerManager extends IContainerLifecycle, IContainerExec, IBackgroundTasks {}
