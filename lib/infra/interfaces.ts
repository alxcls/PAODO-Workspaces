// Abstractions for the two stateful infra singletons (workspace registry + container
// lifecycle). Consumers depend on these interfaces rather than the concrete singletons so
// that tests and the agent layer can inject isolated instances. Production keeps the
// default singletons via lib/infra/services.ts.
//
// Type-only imports below: erased at compile time, so the apparent cycle with
// workspaceStore.ts (which implements IWorkspaceStore) carries no runtime edge.
import type { Workspace } from "../workspace/workspaceStore";
import type { DockerResult } from "./docker/dockerClient";

export interface IWorkspaceStore {
  getWorkspace(id: string): Workspace | undefined;
  getWorkspaceByName(name: string): Workspace | undefined;
  listWorkspaces(): Workspace[];
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: string, name: string): Promise<boolean>;
  deleteWorkspace(id: string): Promise<boolean>;
  setWorkspaceMaxIterations(id: string, n: number): boolean;
  resetWorkspaceMessages(id: string): Promise<void>;
}

export interface IContainerManager {
  ensure(workspaceId: string, workspaceDir: string): Promise<void>;
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
  stop(workspaceId: string): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  getServerPort(workspaceId: string): Promise<number | null>;
  deleteWorkspaceDir(workspaceDir: string): Promise<void>;
  assertDockerAvailable(): Promise<void>;
}
