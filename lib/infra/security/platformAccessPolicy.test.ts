import { describe, expect, it } from "vitest";
import { isPlatformRouteAllowed } from "./platformAccessPolicy";

describe("platform access policy", () => {
  it("allows the shipped workspace routes", () => {
    expect(isPlatformRouteAllowed("GET", "/api/status")).toBe(true);
    expect(isPlatformRouteAllowed("GET", "/api/workspaces")).toBe(true);
    expect(isPlatformRouteAllowed("GET", "/api/workspaces/ws-1")).toBe(true);
    expect(isPlatformRouteAllowed("POST", "/api/workspaces")).toBe(true);
    expect(isPlatformRouteAllowed("PATCH", "/api/workspaces/ws-1")).toBe(true);
    expect(isPlatformRouteAllowed("DELETE", "/api/workspaces/ws-1")).toBe(true);
  });

  // The read side of the model coherence rules: PATCH refuses a model its provider does not serve, so a
  // programmatic caller needs the catalog. Read-only, and only GET — the catalog is code-owned.
  it("grants reading the model catalog but not writing it", () => {
    expect(isPlatformRouteAllowed("GET", "/api/models")).toBe(true);
    expect(isPlatformRouteAllowed("POST", "/api/models")).toBe(false);
  });

  it("allows issue and revoke on both credential channels", () => {
    for (const channel of ["api-key", "mcp-config"]) {
      expect(isPlatformRouteAllowed("POST", `/api/workspaces/ws-1/${channel}`)).toBe(true);
      expect(isPlatformRouteAllowed("DELETE", `/api/workspaces/ws-1/${channel}`)).toBe(true);
    }
  });

  // Reading a channel's state and toggling it stay UI-only. A CLI reads them through the workspace
  // details route, and enabling a channel goes through PATCH on the workspace itself.
  it("does not grant reads or toggles on the credential routes", () => {
    for (const channel of ["api-key", "mcp-config"]) {
      expect(isPlatformRouteAllowed("GET", `/api/workspaces/ws-1/${channel}`)).toBe(false);
      expect(isPlatformRouteAllowed("PATCH", `/api/workspaces/ws-1/${channel}`)).toBe(false);
    }
  });

  it("denies token administration by default", () => {
    expect(isPlatformRouteAllowed("GET", "/api/settings/cli-access")).toBe(false);
    // The route that mints the platform token itself: a leaked key must not renew itself.
    expect(isPlatformRouteAllowed("POST", "/api/settings/cli-access")).toBe(false);
  });

  // The line drawn for BYOK: the CLI may learn that a provider cannot authenticate — that is the
  // `hasKey` flag on GET /api/models, allowed above — but nothing about the key itself, and it may
  // never change one. A leaked automation token must not be able to redirect the deployment's model
  // spend to another account, delete the working keys, or read back the masked hint these routes
  // carry. Asserted per method so widening the policy has to be a deliberate edit here.
  it("denies provider API key administration entirely, including reads", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(isPlatformRouteAllowed(method, "/api/settings/provider-keys")).toBe(false);
      expect(isPlatformRouteAllowed(method, "/api/settings/provider-keys/anthropic")).toBe(false);
    }
  });

  it("allows only the file methods used by the CLI", () => {
    // Listing, reading and deleting: the routes the UI uses too.
    expect(isPlatformRouteAllowed("GET", "/api/workspaces/ws-1/files")).toBe(true);
    expect(isPlatformRouteAllowed("GET", "/api/workspaces/ws-1/files/content")).toBe(true);
    expect(isPlatformRouteAllowed("DELETE", "/api/workspaces/ws-1/files/content")).toBe(true);
    // Push and pull: the one CLI-specific transport.
    expect(isPlatformRouteAllowed("GET", "/api/workspaces/ws-1/files/transfer")).toBe(true);
    expect(isPlatformRouteAllowed("PUT", "/api/workspaces/ws-1/files/transfer")).toBe(true);

    // Nothing wider than the CLI calls. The browser's transports would be a second, non-atomic way to
    // do what transfer does; the editor's save and move have no CLI command behind them at all.
    expect(isPlatformRouteAllowed("POST", "/api/workspaces/ws-1/files/upload")).toBe(false);
    expect(isPlatformRouteAllowed("POST", "/api/workspaces/ws-1/files/download")).toBe(false);
    expect(isPlatformRouteAllowed("PUT", "/api/workspaces/ws-1/files/content")).toBe(false);
    expect(isPlatformRouteAllowed("PATCH", "/api/workspaces/ws-1/files/content")).toBe(false);
  });

  it("allows drive metadata", () => {
    expect(isPlatformRouteAllowed("GET", "/api/drives")).toBe(true);
    expect(isPlatformRouteAllowed("POST", "/api/drives")).toBe(true);
    expect(isPlatformRouteAllowed("GET", "/api/drives/drive-1")).toBe(true);
    expect(isPlatformRouteAllowed("PATCH", "/api/drives/drive-1")).toBe(true);
    expect(isPlatformRouteAllowed("DELETE", "/api/drives/drive-1")).toBe(true);
  });

  // The same five a workspace gets, because `paodo drive file` is the same five commands.
  it("grants a drive's files exactly what it grants a workspace's", () => {
    for (const suffix of ["files", "files/content", "files/transfer"]) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        expect(isPlatformRouteAllowed(method, `/api/drives/drive-1/${suffix}`)).toBe(
          isPlatformRouteAllowed(method, `/api/workspaces/ws-1/${suffix}`),
        );
      }
    }
    expect(isPlatformRouteAllowed("GET", "/api/drives/drive-1/files")).toBe(true);
    expect(isPlatformRouteAllowed("GET", "/api/drives/drive-1/files/content")).toBe(true);
    expect(isPlatformRouteAllowed("DELETE", "/api/drives/drive-1/files/content")).toBe(true);
    expect(isPlatformRouteAllowed("GET", "/api/drives/drive-1/files/transfer")).toBe(true);
    expect(isPlatformRouteAllowed("PUT", "/api/drives/drive-1/files/transfer")).toBe(true);
  });

  // A drive is reachable by every workspace connected to it, so anything wider than the five commands
  // lands in more than one agent's view at once. Asserted per method so widening has to be deliberate.
  it("does not grant the browser's drive transports, the editor's writes, or drive connections", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(isPlatformRouteAllowed(method, "/api/drives/drive-1/files/upload")).toBe(false);
      expect(isPlatformRouteAllowed(method, "/api/drives/drive-1/files/download")).toBe(false);
      expect(isPlatformRouteAllowed(method, "/api/drive-connections")).toBe(false);
    }
    expect(isPlatformRouteAllowed("PUT", "/api/drives/drive-1/files/content")).toBe(false);
    expect(isPlatformRouteAllowed("PATCH", "/api/drives/drive-1/files/content")).toBe(false);
  });
});
