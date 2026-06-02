// Per-workspace secrets (API keys, tokens, config values) injected into PRIVILEGED scripts at run
// time as environment variables — never into the agent's own `execute_command` shell.
//
// Security model (Phase 2 — OS-enforced): the agent runs `execute_command` as the non-root
// `developer` user, so it never has these values in its environment and cannot read this file
// (it lives outside any /workspace bind mount). Secrets reach a process ONLY when the server runs
// a privileged script via `docker exec -u root -e NAME=value ...` — a command the agent cannot
// compose. Values are write-only from the UI: only key NAMES are ever returned to the frontend.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("secrets");

// Derived independently (not imported from workspaceStore) to avoid the
// workspaceStore → containerManager import chain. Same pattern as privilegeStore.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");
const FILE = path.join(WORKSPACES_ROOT, ".secrets.json");

// workspaceId -> { SECRET_NAME: plaintextValue }
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

// POSIX-ish env var identifier (upper-snake). Rejecting anything else keeps `-e NAME=value`
// unambiguous and matches conventional secret naming.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function isValidSecretName(name: string): boolean {
  return NAME_RE.test(name);
}

function save() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, FILE);
  } catch (err) {
    log.error({ err }, "failed to save secret store");
    throw err;
  }
}

export function setSecret(workspaceId: string, name: string, value: string): void {
  if (!isValidSecretName(name)) throw new Error(`invalid secret name: "${name}"`);
  (store[workspaceId] ??= {})[name] = value;
  save();
  log.info({ workspaceId, secretName: name }, "secret set");
}

export function deleteSecret(workspaceId: string, name: string): void {
  const ws = store[workspaceId];
  if (ws && name in ws) {
    delete ws[name];
    if (Object.keys(ws).length === 0) delete store[workspaceId];
    save();
    log.info({ workspaceId, secretName: name }, "secret deleted");
  }
}

// Names only — values are NEVER returned to the frontend (write-only model).
export function listSecretNames(workspaceId: string): string[] {
  return Object.keys(store[workspaceId] ?? {});
}

// Builds `docker exec` env args: each value is a distinct argv element, so no shell interpolation
// occurs and any value (including ones with `=`, spaces, newlines) is passed safely. Server-only —
// must never be surfaced through an API response.
export function getSecretEnvArgs(workspaceId: string): string[] {
  const ws = store[workspaceId];
  if (!ws) return [];
  return Object.entries(ws).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}
