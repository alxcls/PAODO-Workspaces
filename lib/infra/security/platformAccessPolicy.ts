// Explicit bridge between shared HTTP routes and programmatic platform access. A route is UI-only
// unless its exact method/path maps to an entry here. This is the review point for every new CLI
// capability. The one instance-wide CLI key can call every listed route; it has no per-key scopes.
//
// Two consequences worth stating plainly, because neither is obvious from a permission name:
//   - workspaces:update can create a credential. Switching on a workspace's API or MCP access mints
//     that channel's first key and returns it in the PATCH response, so this permission also grants
//     "obtain a workspace key for a channel that had none".
//   - workspaces:delete is irreversible and takes the workspace directory with it.
// /api/settings/cli-access is deliberately absent: it mints and rotates the very token used to
// authenticate here, so a leaked key must not be able to renew itself.

export type PlatformPermission =
  | "status:read"
  | "models:read"
  | "workspaces:list"
  | "workspaces:read"
  | "workspaces:create"
  | "workspaces:update"
  | "workspaces:delete"
  | "workspaces:credentials:rotate"
  | "workspaces:credentials:revoke";

const RULES: ReadonlyArray<{
  method: string;
  pathname: RegExp;
  permission: PlatformPermission;
}> = [
  { method: "GET", pathname: /^\/api\/status$/, permission: "status:read" },
  // The provider/model/effort catalog. Read-only and workspace-independent, and the counterpart to the
  // coherence rules on workspaces:update: a caller that must send a model the provider actually serves
  // needs somewhere to read the valid combinations rather than discovering them through rejections.
  // Discloses which providers have an API key set in .env, which is what makes the list useful — it
  // offers only providers that can authenticate.
  { method: "GET", pathname: /^\/api\/models$/, permission: "models:read" },
  { method: "GET", pathname: /^\/api\/workspaces$/, permission: "workspaces:list" },
  { method: "POST", pathname: /^\/api\/workspaces$/, permission: "workspaces:create" },
  { method: "GET", pathname: /^\/api\/workspaces\/[^/]+$/, permission: "workspaces:read" },
  { method: "PATCH", pathname: /^\/api\/workspaces\/[^/]+$/, permission: "workspaces:update" },
  { method: "DELETE", pathname: /^\/api\/workspaces\/[^/]+$/, permission: "workspaces:delete" },
  // A workspace key's whole life, so an agent can replace a compromised key or close a channel's
  // access without the UI. POST rotates (invalidating the previous key); DELETE revokes without
  // touching the channel's on/off switch.
  {
    method: "POST",
    pathname: /^\/api\/workspaces\/[^/]+\/api-key$/,
    permission: "workspaces:credentials:rotate",
  },
  {
    method: "DELETE",
    pathname: /^\/api\/workspaces\/[^/]+\/api-key$/,
    permission: "workspaces:credentials:revoke",
  },
  {
    method: "POST",
    pathname: /^\/api\/workspaces\/[^/]+\/mcp-config$/,
    permission: "workspaces:credentials:rotate",
  },
  {
    method: "DELETE",
    pathname: /^\/api\/workspaces\/[^/]+\/mcp-config$/,
    permission: "workspaces:credentials:revoke",
  },
];

export function platformPermissionFor(method: string, pathname: string): PlatformPermission | null {
  return RULES.find((rule) => rule.method === method && rule.pathname.test(pathname))?.permission ?? null;
}
