import { describe, expect, it } from "vitest";
import { platformPermissionFor } from "./platformAccessPolicy";

describe("platform access policy", () => {
  it("maps the shipped read capabilities", () => {
    expect(platformPermissionFor("GET", "/api/status")).toBe("status:read");
    expect(platformPermissionFor("GET", "/api/workspaces")).toBe("workspaces:list");
    expect(platformPermissionFor("GET", "/api/workspaces/ws-1")).toBe("workspaces:read");
  });

  it("denies writes, nested resources, and token administration by default", () => {
    expect(platformPermissionFor("POST", "/api/workspaces")).toBeNull();
    expect(platformPermissionFor("PATCH", "/api/workspaces/ws-1")).toBeNull();
    expect(platformPermissionFor("GET", "/api/workspaces/ws-1/files")).toBeNull();
    expect(platformPermissionFor("GET", "/api/settings/cli-access")).toBeNull();
  });
});
