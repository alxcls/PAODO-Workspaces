// Explicit bridge between shared HTTP routes and programmatic platform access. A route is UI-only
// unless its exact method/path maps to an entry here. This is the review point for every new CLI
// capability. The one instance-wide CLI key can call every listed route; it has no per-key scopes.
//
// Two consequences worth stating plainly, because neither is obvious from a permission name:
//   - workspaces:update cannot obtain a credential. Switching a workspace's API or MCP access on or
//     off moves only that channel's open/closed flag; issuing a key is workspaces:credentials:issue
//     on the channel's own route, and is the only way a plaintext secret is ever produced.
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
  | "workspaces:credentials:issue"
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
  // A workspace key's whole life, so an agent can issue, replace or destroy one without the UI. POST
  // carries the operation in its body — generate for a channel with no key, rotate to replace one —
  // and both produce a plaintext, which is why they share a permission rather than splitting on a
  // body field this method/path map cannot see. DELETE revokes unconditionally: destroying a leaked
  // key must not depend on the channel being open, and it leaves the on/off switch alone.
  {
    method: "POST",
    pathname: /^\/api\/workspaces\/[^/]+\/api-key$/,
    permission: "workspaces:credentials:issue",
  },
  {
    method: "DELETE",
    pathname: /^\/api\/workspaces\/[^/]+\/api-key$/,
    permission: "workspaces:credentials:revoke",
  },
  {
    method: "POST",
    pathname: /^\/api\/workspaces\/[^/]+\/mcp-config$/,
    permission: "workspaces:credentials:issue",
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
