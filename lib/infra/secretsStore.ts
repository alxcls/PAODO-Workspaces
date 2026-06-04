// Per-workspace key-value secrets store, persisted to disk.
// Secrets are injected as environment variables when privileged scripts run.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "./workspaceStore";
import { createLogger } from "./logger";

const log = createLogger("secrets");
const FILE = path.join(WORKSPACES_ROOT, ".secrets.json");

type Store = Record<string, Record<string, string>>;

const g = global as typeof global & { _secrets?: Store };
if (!g._secrets) {
  try {
    g._secrets = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch {
    g._secrets = {};
  }
}
const store = g._secrets;

function save() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, FILE);
  } catch (err) {
    log.error({ err }, "failed to save secrets store");
    throw err;
  }
}

export function listSecrets(workspaceId: string): { name: string }[] {
  return Object.keys(store[workspaceId] ?? {}).map((name) => ({ name }));
}

export function getSecrets(workspaceId: string): Record<string, string> {
  return { ...(store[workspaceId] ?? {}) };
}

export function setSecret(workspaceId: string, name: string, value: string) {
  store[workspaceId] = { ...(store[workspaceId] ?? {}), [name]: value };
  save();
  log.info({ workspaceId, name }, "secret set");
}

export function deleteSecret(workspaceId: string, name: string): boolean {
  if (!store[workspaceId]?.[name]) return false;
  delete store[workspaceId][name];
  save();
  log.info({ workspaceId, name }, "secret deleted");
  return true;
}

export function deleteAllSecrets(workspaceId: string) {
  delete store[workspaceId];
  save();
}
