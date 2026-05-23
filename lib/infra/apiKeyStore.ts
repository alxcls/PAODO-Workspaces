// Manages per-workspace API keys used to authenticate external agent calls.
// Keys are stored as SHA-256 hashes in a JSON file on disk so the plaintext is never persisted.
// Supports generating, revoking, and enabling/disabling keys, as well as constant-time validation.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "./workspaceStore";
import { createLogger } from "./logger";

const log = createLogger("apiKeys");

const FILE = path.join(WORKSPACES_ROOT, ".api-keys.json");

type Store = Record<string, { keyHash: string | null; enabled: boolean }>;

function load(): Store {
  try {
    return JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch {
    log.debug("api key store not found — starting fresh");
    return {};
  }
}

// NOTE — same single-instance constraint as workspaceStore: no file locking, concurrent
// calls can clobber each other. Acceptable for single-user deployments.
function save(s: Store) {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(s, null, 2));
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
  const s = load();
  s[workspaceId] = { keyHash: hash, enabled: true };
  save(s);
  log.info({ workspaceId }, "api key set");
}

export function revokeKey(workspaceId: string) {
  const s = load();
  if (s[workspaceId]) s[workspaceId].keyHash = null;
  save(s);
  log.info({ workspaceId }, "api key revoked");
}

export function setEnabled(workspaceId: string, enabled: boolean) {
  const s = load();
  s[workspaceId] = { keyHash: s[workspaceId]?.keyHash ?? null, enabled };
  save(s);
  log.info({ workspaceId, enabled }, "api key enabled state changed");
}

export function getState(workspaceId: string): { keyHash: string | null; enabled: boolean } {
  return load()[workspaceId] ?? { keyHash: null, enabled: false };
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
