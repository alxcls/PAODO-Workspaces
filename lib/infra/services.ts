// Service provider for the two stateful infra singletons. API routes and server.ts obtain the
// workspace store and container manager through getStore()/getContainers() instead of importing
// the concrete singletons directly — so tests can swap in fakes via setServices() (Next.js route
// handlers have fixed signatures, so this accessor is the per-request injection point).
//
// Leaf module: imports only the concrete infra. The agent layer must NOT import this file — it
// receives store/containers via constructor/argument injection to stay cycle-free and pure.
import { defaultWorkspaceStore } from "../workspace/workspaceStore";
import { defaultContainerManager } from "./docker/containerManager";
import { defaultWorkspaceVersioning } from "./git";
import type { IWorkspaceStore, IContainerManager, IWorkspaceVersioning } from "./interfaces";

interface Services {
  store: IWorkspaceStore;
  containers: IContainerManager;
  versioning: IWorkspaceVersioning;
}

const defaults: Services = {
  store: defaultWorkspaceStore,
  containers: defaultContainerManager,
  versioning: defaultWorkspaceVersioning,
};

let current: Services = { ...defaults };

export function getStore(): IWorkspaceStore {
  return current.store;
}

export function getContainers(): IContainerManager {
  return current.containers;
}

export function getVersioning(): IWorkspaceVersioning {
  return current.versioning;
}

/** Test-only: override one or both services with fakes. */
export function setServices(partial: Partial<Services>): void {
  current = { ...current, ...partial };
}

/** Test-only: restore the production singletons. */
export function resetServices(): void {
  current = { ...defaults };
}
