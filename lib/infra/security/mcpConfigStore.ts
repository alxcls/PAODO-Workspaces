// Per-workspace Workspace-MCP configuration: whether the workspace exposes a Streamable-HTTP MCP
// endpoint, its revocable bearer secret (stored only as a SHA-256 hash, like apiKeyStore), and the
// set of skill ids selected for exposure. "Published" is exactly this selection — there is no
// separate per-skill flag. Mirrors the apiKeyStore/scheduleStore idiom (globalSingleton +
// atomicSaveJson/readJson under WORKSPACES_ROOT) rather than bloating workspaceStore.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createAuditLogger, createLogger } from "../logger";

const log = createLogger("mcpConfig");
const audit = createAuditLogger("mcpConfig");

const FILE = path.join(WORKSPACES_ROOT, ".mcp-config.json");

export interface McpConfigEntry {
  enabled: boolean;
  secretHash: string | null;
  selectedSkillIds: string[];
}

type Store = Record<string, McpConfigEntry>;

const store = globalSingleton<Store>("mcpConfig", () => readJson<Store>(FILE, {}));

const EMPTY: McpConfigEntry = { enabled: false, secretHash: null, selectedSkillIds: [] };

function save() {
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error({ err }, "failed to save mcp config store");
    throw err;
  }
}

function entry(workspaceId: string): McpConfigEntry {
  return store[workspaceId] ?? { ...EMPTY, selectedSkillIds: [] };
}

function hashSecret(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

/** Generates a fresh MCP bearer secret. Only the hash is persisted; the plaintext is shown once. */
export function generateSecret(): { plain: string; hash: string } {
  const plain = "mcp_" + randomBytes(32).toString("hex");
  return { plain, hash: hashSecret(plain) };
}

export function getState(workspaceId: string): McpConfigEntry {
  const e = entry(workspaceId);
  // Return a copy so callers can't mutate the stored array in place.
  return { enabled: e.enabled, secretHash: e.secretHash, selectedSkillIds: [...e.selectedSkillIds] };
}

export function setEnabled(workspaceId: string, enabled: boolean) {
  store[workspaceId] = { ...entry(workspaceId), enabled };
  save();
  audit.info({ workspaceId, enabled, event: "mcp_enabled_changed" }, "workspace mcp enabled state changed");
}

/** Mints (or rotates) the bearer secret and returns the plaintext once. Enables the MCP. */
export function mintSecret(workspaceId: string): string {
  const { plain, hash } = generateSecret();
  store[workspaceId] = { ...entry(workspaceId), secretHash: hash, enabled: true };
  save();
  audit.info({ workspaceId, event: "mcp_secret_minted" }, "workspace mcp secret minted");
  return plain;
}

export function revokeSecret(workspaceId: string) {
  if (store[workspaceId]) {
    store[workspaceId] = { ...store[workspaceId], secretHash: null };
    save();
  }
  audit.info({ workspaceId, event: "mcp_secret_revoked" }, "workspace mcp secret revoked");
}

export function setSelectedSkills(workspaceId: string, skillIds: string[]) {
  // Dedupe and drop non-strings defensively; order is preserved for stable UI rendering.
  const seen = new Set<string>();
  const cleaned = skillIds.filter((s) => typeof s === "string" && s && !seen.has(s) && seen.add(s));
  store[workspaceId] = { ...entry(workspaceId), selectedSkillIds: cleaned };
  save();
  audit.info(
    { workspaceId, count: cleaned.length, event: "mcp_selected_skills_updated" },
    "workspace mcp selected skills updated",
  );
}

export function deleteForWorkspace(workspaceId: string) {
  if (!(workspaceId in store)) return;
  delete store[workspaceId];
  save();
  audit.info({ workspaceId, event: "mcp_config_deleted" }, "workspace mcp config deleted");
}

/**
 * Constant-time validation of a presented bearer secret. Returns false when the MCP is disabled or
 * no secret is set, so disabling or revoking takes effect immediately.
 */
export function validateSecret(workspaceId: string, plain: string): boolean {
  const { enabled, secretHash } = entry(workspaceId);
  if (!enabled || !secretHash) return false;
  return timingSafeEqual(Buffer.from(hashSecret(plain)), Buffer.from(secretHash));
}
