// Routes the one instance-wide CLI key may call. A route is UI-only unless its exact method/path is
// listed here.
//
// PATCH on a workspace cannot obtain a credential. Issuing a key requires POST on the channel's own
// route. DELETE on a workspace is irreversible and takes its directory with it.
// /api/settings/cli-access is deliberately absent: it mints and rotates the very token used to
// authenticate here, so a leaked key must not be able to renew itself.
// /api/settings/provider-keys is absent for the neighbouring reason: PUT and DELETE there decide
// which account the deployment's model spend is billed to, so a leaked key must not be able to
// redirect it or destroy the working one. Its GET is absent too — not because status is sensitive,
// but because that response carries each key's masked last characters, which the plain `hasKey` flag
// on /api/models below deliberately does not.

/**
 * A rule for a route under one workspace: `/api/workspaces/<id>/<suffix>`, or the workspace itself
 * when `suffix` is omitted. Most of this policy is that shape, and hand-writing the regex each time
 * is how a rule ends up matching more (or less) than its author read it as — an unescaped dot or a
 * missing `$` is invisible in review and silent at runtime. The id segment matches one path segment
 * and nothing else, so a rule can never span into a sub-resource it did not name.
 */
function workspaceRule(method: string, suffix?: string) {
  const tail = suffix === undefined ? "" : `/${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  return { method, pathname: new RegExp(`^/api/workspaces/[^/]+${tail}$`) };
}

const RULES: ReadonlyArray<{
  method: string;
  pathname: RegExp;
}> = [
  { method: "GET", pathname: /^\/api\/status$/ },
  // The provider/model/effort catalog. Read-only and workspace-independent, and the counterpart to the
  // coherence rules on workspace PATCH: a caller that must send a model the provider actually serves
  // needs somewhere to read the valid combinations rather than discovering them through rejections.
  // Now lists every provider this deployment offers, keyed or not, and reports which can authenticate
  // as a `hasKey` boolean — so a caller can tell "this model is not served" from "nobody has paid for
  // this provider yet" without either being discovered through a failed run.
  { method: "GET", pathname: /^\/api\/models$/ },
  { method: "GET", pathname: /^\/api\/workspaces$/ },
  { method: "POST", pathname: /^\/api\/workspaces$/ },
  workspaceRule("GET"),
  workspaceRule("PATCH"),
  workspaceRule("DELETE"),
  workspaceRule("POST", "api-key"),
  workspaceRule("DELETE", "api-key"),
  workspaceRule("POST", "mcp-config"),
  workspaceRule("DELETE", "mcp-config"),
  workspaceRule("GET", "files"),
  workspaceRule("GET", "files/content"),
  workspaceRule("DELETE", "files/content"),
  workspaceRule("GET", "files/transfer"),
  workspaceRule("PUT", "files/transfer"),
];

export function isPlatformRouteAllowed(method: string, pathname: string): boolean {
  return RULES.some((rule) => rule.method === method && rule.pathname.test(pathname));
}
