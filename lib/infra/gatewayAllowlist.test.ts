// The public gateway and the application must allow exactly the same set of method/path pairs.
//
// The app default-denies on its own, so a gateway that is WIDER than the policy is only redundant.
// A gateway that is NARROWER is a silent outage: deploy/Caddyfile.workspace-api was written against
// an older, three-rule policy and kept answering a plain-text 404 for GET /api/models, POST/PATCH/
// DELETE on workspaces and both credential channels — six of the nine CLI commands — long after the
// app had authorized them. Nothing failed loudly, because a 404 from the edge is indistinguishable
// from a route that does not exist.
//
// So this compares the two allowlists directly rather than trusting a comment to keep them in step.
// The Caddyfile patterns are read out of the deployed file and evaluated here; they use only
// constructs whose meaning is identical in RE2 and JS (anchors, character classes, non-capturing
// alternation), so running them through the JS engine is faithful.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { isPlatformRouteAllowed } from "./security/platformAccessPolicy";

const CADDYFILE = path.resolve(__dirname, "../../deploy/Caddyfile.workspace-api");

/**
 * Every named matcher in the Caddyfile, as the method/path pair it admits. Matchers pair one
 * `method` line with one `path_regexp` line, which is what makes them a faithful mirror of the
 * policy's method-plus-pathname rules.
 */
function gatewayMatchers(): Array<{ name: string; method: string; pattern: RegExp }> {
  const source = fs.readFileSync(CADDYFILE, "utf-8");
  const matchers: Array<{ name: string; method: string; pattern: RegExp }> = [];
  const blocks = source.matchAll(/^\t*@(\w+)\s*\{([^}]*)\}/gm);
  for (const [, name, body] of blocks) {
    const method = /^\s*method\s+(\S+)\s*$/m.exec(body)?.[1];
    const pattern = /^\s*path_regexp\s+\S+\s+(\S+)\s*$/m.exec(body)?.[1];
    if (!method || !pattern) throw new Error(`@${name} is not a method + path_regexp pair`);
    matchers.push({ name, method, pattern: new RegExp(pattern) });
  }
  if (matchers.length === 0) throw new Error("parsed no named matchers — the Caddyfile shape changed");
  return matchers;
}

/**
 * The two routes the gateway forwards that the platform policy does not cover. They authenticate
 * per-workspace inside the route handler instead of against the instance-wide CLI key, so they are
 * deliberately absent from platformAccessPolicy and must be excluded from the comparison.
 */
const ROUTE_AUTHENTICATED = new Set(["workspaceAgent", "workspaceMcp"]);

function gatewayAllows(matchers: ReturnType<typeof gatewayMatchers>, method: string, pathname: string): boolean {
  return matchers.some((m) => !ROUTE_AUTHENTICATED.has(m.name) && m.method === method && m.pattern.test(pathname));
}

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"];

const ID = "b6b8b4f1-0000-4000-8000-000000000000";

// Every /api route the app actually serves, plus near-miss shapes that a sloppy regex would let
// through: a collection verb aimed at a member, a member verb aimed at the collection, an id
// containing a slash, and a trailing segment after an allowed leaf.
const PATHS = [
  "/",
  "/api",
  "/api/status",
  "/api/status/x",
  "/api/models",
  "/api/models/x",
  "/api/config",
  "/api/usage",
  `/api/usage/${ID}`,
  "/api/agent",
  "/api/drives",
  `/api/drives/${ID}`,
  `/api/drives/${ID}/files`,
  `/api/drives/${ID}/files/upload`,
  "/api/drive-connections",
  "/api/workspace-graph",
  "/api/settings/cli-access",
  "/api/workspaces",
  "/api/workspaces/",
  `/api/workspaces/${ID}`,
  `/api/workspaces/${ID}/`,
  `/api/workspaces/${ID}/agent`,
  `/api/workspaces/${ID}/mcp`,
  `/api/workspaces/${ID}/api-key`,
  `/api/workspaces/${ID}/api-key/x`,
  `/api/workspaces/${ID}/mcp-config`,
  `/api/workspaces/${ID}/mcp-config/x`,
  `/api/workspaces/${ID}/chat`,
  `/api/workspaces/${ID}/conversations`,
  `/api/workspaces/${ID}/conversations/${ID}`,
  `/api/workspaces/${ID}/conversations/${ID}/stop`,
  `/api/workspaces/${ID}/diff`,
  `/api/workspaces/${ID}/env-vars`,
  `/api/workspaces/${ID}/env-vars/API_KEY`,
  `/api/workspaces/${ID}/files`,
  `/api/workspaces/${ID}/files/content`,
  `/api/workspaces/${ID}/files/transfer`,
  // These two exist and must stay UI-only, so they are probed to prove the gateway refuses them.
  `/api/workspaces/${ID}/files/download`,
  `/api/workspaces/${ID}/files/upload`,
  `/api/workspaces/${ID}/history`,
  `/api/workspaces/${ID}/internet-access`,
  `/api/workspaces/${ID}/restore`,
  `/api/workspaces/${ID}/schedule`,
  `/api/workspaces/${ID}/system-prompt`,
  `/api/workspaces/${ID}/../${ID}`,
  "/ws",
  "/settings",
];

describe("public gateway allowlist", () => {
  it("forwards exactly the method/path pairs the platform policy authorizes", () => {
    const matchers = gatewayMatchers();
    const disagreements: string[] = [];

    for (const method of METHODS) {
      for (const pathname of PATHS) {
        const edge = gatewayAllows(matchers, method, pathname);
        const app = isPlatformRouteAllowed(method, pathname);
        if (edge !== app) {
          disagreements.push(
            `${method} ${pathname}: gateway ${edge ? "forwards" : "refuses"}, policy ${app ? "allows" : "denies"}`,
          );
        }
      }
    }

    expect(disagreements).toEqual([]);
  });

  it("covers every policy rule, so the corpus cannot pass by matching nothing", () => {
    const matchers = gatewayMatchers();
    const forwarded = METHODS.flatMap((method) =>
      PATHS.filter((pathname) => gatewayAllows(matchers, method, pathname)).map((pathname) => `${method} ${pathname}`),
    );
    expect(forwarded.sort()).toEqual([
      `DELETE /api/drives/${ID}`,
      `DELETE /api/workspaces/${ID}`,
      `DELETE /api/workspaces/${ID}/api-key`,
      `DELETE /api/workspaces/${ID}/files/content`,
      `DELETE /api/workspaces/${ID}/mcp-config`,
      "GET /api/drives",
      `GET /api/drives/${ID}`,
      "GET /api/models",
      "GET /api/status",
      "GET /api/workspaces",
      `GET /api/workspaces/${ID}`,
      `GET /api/workspaces/${ID}/files`,
      `GET /api/workspaces/${ID}/files/content`,
      `GET /api/workspaces/${ID}/files/transfer`,
      `PATCH /api/drives/${ID}`,
      `PATCH /api/workspaces/${ID}`,
      "POST /api/drives",
      "POST /api/workspaces",
      `POST /api/workspaces/${ID}/api-key`,
      `POST /api/workspaces/${ID}/mcp-config`,
      `PUT /api/workspaces/${ID}/files/transfer`,
    ]);
  });

  it("strips and re-sets the forwarding headers on every proxied route", () => {
    const source = fs.readFileSync(CADDYFILE, "utf-8");
    // Each upstream snippet must inherit the hygiene rather than restate it: a block that omits it
    // trusts a client-supplied CF-Connecting-IP, letting a caller pick their own brute-force bucket
    // and forge the address in the audit trail.
    const proxies = source.match(/reverse_proxy\s+\S+\s*\{[\s\S]*?\n\t\}/g) ?? [];
    expect(proxies.length).toBeGreaterThanOrEqual(3);
    for (const proxy of proxies) expect(proxy).toContain("import forwardedHeaders");
    expect(source).toMatch(/\(forwardedHeaders\)\s*\{[\s\S]*?header_up CF-Connecting-IP \{remote_host\}/);
  });
});
