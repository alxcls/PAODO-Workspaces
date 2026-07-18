// Manages per-workspace API keys used to authenticate external agent calls.
// Keys are stored as SHA-256 hashes in a JSON file on disk so the plaintext is never persisted.
// Supports generating, revoking, and enabling/disabling keys, as well as constant-time validation.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createAuditLogger, createLogger } from "../logger";

const log = createLogger("apiKeys");
const audit = createAuditLogger("apiKeys");

const FILE = path.join(WORKSPACES_ROOT, ".api-keys.json");

type Store = Record<string, { keyHash: string | null; enabled: boolean }>;

const store = globalSingleton<Store>("apiKeys", () => readJson<Store>(FILE, {}));

function save() {
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error({ err }, "failed to save api key store");
    throw err;
  }
}

export function generateKey(): { plain: string; hash: string } {
  const plain = "sk_" + randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(plain).digest("hex");
  return { plain, hash };
}

function hashKey(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export function setKey(workspaceId: string, hash: string) {
  store[workspaceId] = { keyHash: hash, enabled: true };
  save();
  audit.info({ workspaceId, event: "api_key_set" }, "api key set");
}

export function revokeKey(workspaceId: string) {
  if (store[workspaceId]) store[workspaceId].keyHash = null;
  save();
  audit.info({ workspaceId, event: "api_key_revoked" }, "api key revoked");
}

export function deleteKey(workspaceId: string) {
  if (!(workspaceId in store)) return;
  delete store[workspaceId];
  save();
  audit.info({ workspaceId, event: "api_key_deleted" }, "api key deleted");
}

export function setEnabled(workspaceId: string, enabled: boolean) {
  store[workspaceId] = { keyHash: store[workspaceId]?.keyHash ?? null, enabled };
  save();
  audit.info({ workspaceId, enabled, event: "api_key_enabled_changed" }, "api key enabled state changed");
}

export function getState(workspaceId: string): { keyHash: string | null; enabled: boolean } {
  return store[workspaceId] ?? { keyHash: null, enabled: false };
}

export function validateKey(workspaceId: string, plain: string): boolean {
  const { keyHash, enabled } = getState(workspaceId);
  if (!enabled || !keyHash) return false;
  return timingSafeEqual(Buffer.from(hashKey(plain)), Buffer.from(keyHash));
}
