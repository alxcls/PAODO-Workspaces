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
  return resourceRule("workspaces", method, suffix);
}

/** The same shape for a drive, so neither collection's rules are hand-written regexes. */
function driveRule(method: string, suffix?: string) {
  return resourceRule("drives", method, suffix);
}

function resourceRule(collection: string, method: string, suffix?: string) {
  const tail = suffix === undefined ? "" : `/${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  return { method, pathname: new RegExp(`^/api/${collection}/[^/]+${tail}$`) };
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
  // Drive metadata, then a drive's files — the same five methods a workspace's files get above, and
  // for the same commands. Neither collection gets the browser's upload/download transports or the
  // editor's save and move: a drive is reachable by every workspace connected to it, so widening its
  // file surface past what the CLI actually calls widens it for all of them at once.
  // /api/drive-connections is still absent — connecting a drive is a capability of its own, and this
  // policy is the place that has to name it deliberately rather than inherit it from the group.
  { method: "GET", pathname: /^\/api\/drives$/ },
  { method: "POST", pathname: /^\/api\/drives$/ },
  driveRule("GET"),
  driveRule("PATCH"),
  driveRule("DELETE"),
  driveRule("GET", "files"),
  driveRule("GET", "files/content"),
  driveRule("DELETE", "files/content"),
  driveRule("GET", "files/transfer"),
  driveRule("PUT", "files/transfer"),
];

export function isPlatformRouteAllowed(method: string, pathname: string): boolean {
  return RULES.some((rule) => rule.method === method && rule.pathname.test(pathname));
}
