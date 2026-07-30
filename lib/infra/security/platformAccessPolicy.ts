// Explicit bridge between shared HTTP routes and programmatic platform access. A route is UI-only
// unless its exact method/path maps to an entry here. This is the review point for every new CLI
// capability. The one instance-wide CLI key can call every listed route; it has no per-key scopes.

export type PlatformPermission = "status:read" | "workspaces:list" | "workspaces:read";

const RULES: ReadonlyArray<{
  method: string;
  pathname: RegExp;
  permission: PlatformPermission;
}> = [
  { method: "GET", pathname: /^\/api\/status$/, permission: "status:read" },
  { method: "GET", pathname: /^\/api\/workspaces$/, permission: "workspaces:list" },
  { method: "GET", pathname: /^\/api\/workspaces\/[^/]+$/, permission: "workspaces:read" },
];

export function platformPermissionFor(method: string, pathname: string): PlatformPermission | null {
  return RULES.find((rule) => rule.method === method && rule.pathname.test(pathname))?.permission ?? null;
}
