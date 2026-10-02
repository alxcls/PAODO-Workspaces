// Routes the one instance-wide CLI key may call; any method/path not listed is UI-only. Absent on purpose:
// settings/cli-access (a leaked key must not renew itself) and settings/provider-keys (see /api/models).

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
  // The model catalog, so workspace PATCH callers read valid combinations instead of learning by rejection.
  // Its `hasKey` flag replaces provider-keys, whose GET leaks masked key hints and whose writes move billing.
  { method: "GET", pathname: /^\/api\/models$/ },
  { method: "GET", pathname: /^\/api\/workspaces$/ },
  { method: "POST", pathname: /^\/api\/workspaces$/ },
  workspaceRule("GET"),
  // PATCH cannot obtain a credential: issuing a key is POST on the channel's own route below.
  workspaceRule("PATCH"),
  // Irreversible: deleting a workspace takes its directory with it.
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
  // The one scheduled job: read, replace, or update named fields. There is no DELETE — pausing is `enabled: false`.
  workspaceRule("GET", "schedule"),
  workspaceRule("PUT", "schedule"),
  workspaceRule("PATCH", "schedule"),
  /**
   * Drive metadata, then a drive's files — the same five methods a workspace's files get above, and
   * for the same commands. Neither collection gets the browser's upload/download transports or the
   * editor's save and move: a drive is reachable by every workspace connected to it, so widening its
   * file surface past what the CLI actually calls widens it for all of them at once.
   */
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
  /**
   * Both connection graphs: read whole, written one edge at a time. Reading is what makes the rest of
   * this policy usable — a drive is addressed by name only from a workspace connected to it, and an
   * edge of either kind is removed by an id these two routes are the only source of.
   *
   * PUT on /api/workspace-graph is deliberately absent, which is why the write here is a sub-resource
   * rather than that. It replaces the document whole — edges and the editor's node positions together
   * — so a caller with no canvas to send would erase a layout on its way to adding one edge. POST and
   * DELETE on /edges touch edges alone and carry the stored positions through.
   *
   * GET /api/workspace-graph answers with those positions beside the edges. That is canvas layout,
   * meaningless outside the editor rather than sensitive, and it is served whole because the route is
   * the UI's: filtering a response per caller would make it two routes wearing one path.
   */
  { method: "GET", pathname: /^\/api\/drive-connections$/ },
  { method: "POST", pathname: /^\/api\/drive-connections$/ },
  { method: "DELETE", pathname: /^\/api\/drive-connections$/ },
  { method: "GET", pathname: /^\/api\/workspace-graph$/ },
  { method: "POST", pathname: /^\/api\/workspace-graph\/edges$/ },
  { method: "DELETE", pathname: /^\/api\/workspace-graph\/edges$/ },
];

export function isPlatformRouteAllowed(method: string, pathname: string): boolean {
  return RULES.some((rule) => rule.method === method && rule.pathname.test(pathname));
}
