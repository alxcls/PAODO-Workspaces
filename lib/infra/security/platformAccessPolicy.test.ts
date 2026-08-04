import { describe, expect, it } from "vitest";
import { platformPermissionFor } from "./platformAccessPolicy";

describe("platform access policy", () => {
  it("maps the shipped workspace capabilities", () => {
    expect(platformPermissionFor("GET", "/api/status")).toBe("status:read");
    expect(platformPermissionFor("GET", "/api/workspaces")).toBe("workspaces:list");
    expect(platformPermissionFor("GET", "/api/workspaces/ws-1")).toBe("workspaces:read");
    expect(platformPermissionFor("POST", "/api/workspaces")).toBe("workspaces:create");
    expect(platformPermissionFor("PATCH", "/api/workspaces/ws-1")).toBe("workspaces:update");
    expect(platformPermissionFor("DELETE", "/api/workspaces/ws-1")).toBe("workspaces:delete");
  });

  // The read side of the model coherence rules: PATCH refuses a model its provider does not serve, so a
  // programmatic caller needs the catalog. Read-only, and only GET — the catalog is code-owned.
  it("grants reading the model catalog but not writing it", () => {
    expect(platformPermissionFor("GET", "/api/models")).toBe("models:read");
    expect(platformPermissionFor("POST", "/api/models")).toBeNull();
  });

  it("maps rotate and revoke on both credential channels", () => {
    for (const channel of ["api-key", "mcp-config"]) {
      expect(platformPermissionFor("POST", `/api/workspaces/ws-1/${channel}`)).toBe("workspaces:credentials:rotate");
      expect(platformPermissionFor("DELETE", `/api/workspaces/ws-1/${channel}`)).toBe("workspaces:credentials:revoke");
    }
  });

  // Reading a channel's state and toggling it stay UI-only. A CLI reads them through the workspace
  // details route, and enabling a channel goes through workspaces:update on the workspace itself.
  it("does not grant reads or toggles on the credential routes", () => {
    for (const channel of ["api-key", "mcp-config"]) {
      expect(platformPermissionFor("GET", `/api/workspaces/ws-1/${channel}`)).toBeNull();
      expect(platformPermissionFor("PATCH", `/api/workspaces/ws-1/${channel}`)).toBeNull();
    }
  });

  it("denies nested resources and token administration by default", () => {
    expect(platformPermissionFor("GET", "/api/workspaces/ws-1/files")).toBeNull();
    expect(platformPermissionFor("GET", "/api/settings/cli-access")).toBeNull();
    // The route that mints the platform token itself: a leaked key must not renew itself.
    expect(platformPermissionFor("POST", "/api/settings/cli-access")).toBeNull();
  });
});
