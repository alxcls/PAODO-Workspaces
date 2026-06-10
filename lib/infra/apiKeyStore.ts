// Manages per-workspace API keys used to authenticate external agent calls.
// Keys are stored as SHA-256 hashes in a JSON file on disk so the plaintext is never persisted.
// Supports generating, revoking, and enabling/disabling keys, as well as constant-time validation.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "./paths";
import { atomicSaveJson } from "./jsonPersist";
import { createLogger } from "./logger";

const log = createLogger("apiKeys");

const FILE = path.join(WORKSPACES_ROOT, ".api-keys.json");

type Store = Record<string, { keyHash: string | null; enabled: boolean }>;

const g = global as typeof global & { _apiKeys?: Store };
if (!g._apiKeys) {
  try {
    g._apiKeys = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch {
    g._apiKeys = {};
  }
}
const store = g._apiKeys;

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
  log.info({ workspaceId }, "api key set");
}

export function revokeKey(workspaceId: string) {
  if (store[workspaceId]) store[workspaceId].keyHash = null;
  save();
  log.info({ workspaceId }, "api key revoked");
}

export function setEnabled(workspaceId: string, enabled: boolean) {
  store[workspaceId] = { keyHash: store[workspaceId]?.keyHash ?? null, enabled };
  save();
  log.info({ workspaceId, enabled }, "api key enabled state changed");
}

export function getState(workspaceId: string): { keyHash: string | null; enabled: boolean } {
  return store[workspaceId] ?? { keyHash: null, enabled: false };
}

export function validateKey(workspaceId: string, plain: string): boolean {
  const { keyHash, enabled } = getState(workspaceId);
  if (!enabled || !keyHash) {
    log.warn({ workspaceId, reason: !enabled ? "disabled" : "no key set" }, "api key validation failed");
    return false;
  }
  const ok = timingSafeEqual(Buffer.from(hashKey(plain)), Buffer.from(keyHash));
  if (!ok) log.warn({ workspaceId }, "api key validation failed — bad key");
  return ok;
}
