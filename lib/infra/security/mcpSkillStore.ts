// Which of a workspace's skills are exposed through its Workspace-MCP endpoint. "Published" is
// exactly this selection — there is no separate per-skill flag.
//
// This is feature configuration, not a credential: the MCP bearer secret and the enabled flag live in
// credentialStore.ts under the "workspace-mcp" kind. Keeping them apart is what stopped one `enabled`
// field from meaning both "the endpoint is exposed" and "the secret is usable".
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createAuditLogger, createLogger } from "../logger";

const log = createLogger("mcpSkills");
const audit = createAuditLogger("mcpSkills");

const FILE = path.join(WORKSPACES_ROOT, ".mcp-skills.json");

type Store = Record<string, string[]>;

const store = globalSingleton<Store>("mcpSkills", () => readJson<Store>(FILE, {}));

function save(workspaceId: string, operation: string) {
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error(
      {
        event: "mcp_skill_store_save_failed",
        outcome: "mcp_skill_selection_not_persisted",
        err,
        workspaceId,
        operation,
        filePath: FILE,
      },
      "failed to save mcp skill selection",
    );
    throw err;
  }
}

/** Returns a copy, so callers cannot mutate the stored selection in place. */
export function getSelectedSkills(workspaceId: string): string[] {
  return [...(store[workspaceId] ?? [])];
}

export function setSelectedSkills(workspaceId: string, skillIds: string[]) {
  // Dedupe and drop non-strings defensively; order is preserved for stable UI rendering.
  const seen = new Set<string>();
  const cleaned = skillIds.filter((s) => typeof s === "string" && s && !seen.has(s) && seen.add(s));
  store[workspaceId] = cleaned;
  save(workspaceId, "set_selected_skills");
  audit.info(
    { workspaceId, count: cleaned.length, event: "mcp_selected_skills_updated" },
    "workspace mcp selected skills updated",
  );
}

export function removeWorkspace(workspaceId: string) {
  if (!(workspaceId in store)) return;
  delete store[workspaceId];
  save(workspaceId, "remove_workspace");
  audit.info({ workspaceId, event: "mcp_skill_selection_removed" }, "workspace mcp skill selection removed");
}
