// Routes the one instance-wide CLI key may call. A route is UI-only unless its exact method/path is
// listed here.
//
// PATCH on a workspace cannot obtain a credential. Issuing a key requires POST on the channel's own
// route. DELETE on a workspace is irreversible and takes its directory with it.
// /api/settings/cli-access is deliberately absent: it mints and rotates the very token used to
// authenticate here, so a leaked key must not be able to renew itself.

const RULES: ReadonlyArray<{
  method: string;
  pathname: RegExp;
}> = [
  { method: "GET", pathname: /^\/api\/status$/ },
  // The provider/model/effort catalog. Read-only and workspace-independent, and the counterpart to the
  // coherence rules on workspace PATCH: a caller that must send a model the provider actually serves
  // needs somewhere to read the valid combinations rather than discovering them through rejections.
  // Discloses which providers have an API key set in .env, which is what makes the list useful — it
  // offers only providers that can authenticate.
  { method: "GET", pathname: /^\/api\/models$/ },
  { method: "GET", pathname: /^\/api\/workspaces$/ },
  { method: "POST", pathname: /^\/api\/workspaces$/ },
  { method: "GET", pathname: /^\/api\/workspaces\/[^/]+$/ },
  { method: "PATCH", pathname: /^\/api\/workspaces\/[^/]+$/ },
  { method: "DELETE", pathname: /^\/api\/workspaces\/[^/]+$/ },
  { method: "POST", pathname: /^\/api\/workspaces\/[^/]+\/api-key$/ },
  { method: "DELETE", pathname: /^\/api\/workspaces\/[^/]+\/api-key$/ },
  { method: "POST", pathname: /^\/api\/workspaces\/[^/]+\/mcp-config$/ },
  { method: "DELETE", pathname: /^\/api\/workspaces\/[^/]+\/mcp-config$/ },
];

export function isPlatformRouteAllowed(method: string, pathname: string): boolean {
  return RULES.some((rule) => rule.method === method && rule.pathname.test(pathname));
}
