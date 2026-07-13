// buildWorkspacePromptInputs is the single place that gathers a workspace's dynamic prompt
// pieces (AGENTS.md + connected-drives block). These tests pin the four combinations of
// present/absent for each, since every system-prompt path depends on this behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Drive } from "../workspace/driveStore";

// The drive list is looked up by id; mock it so the test owns the result without touching disk.
// formatDriveLine is pure presentation — mirror the production rendering so the prompt assertions
// exercise the real one-line shape (`- <name> (id: <id>)<desc>`).
const getDrivesForWorkspace = vi.fn<(workspaceId: string) => Drive[]>();
vi.mock("../workspace/driveStore", () => ({
  getDrivesForWorkspace: (id: string) => getDrivesForWorkspace(id),
  formatDriveLine: (d: Drive) => `- ${d.name} (id: ${d.id})${d.description ? ` — ${d.description}` : ""}`,
}));

// calleeInfo is gated on the workspace being a callee (an incoming graph edge); mock it so
// the test owns whether the guidance block is present without touching the graph file.
const isCallee = vi.fn<(workspaceId: string) => boolean>();
vi.mock("../workspace/workspaceGraph", () => ({
  isCallee: (id: string) => isCallee(id),
}));

const listSecretMeta = vi.fn();
vi.mock("../infra/security/workspaceSecretStore", () => ({
  listSecretMeta: (id: string) => listSecretMeta(id),
}));

import { buildWorkspacePromptInputs } from "./promptContext";

function drive(name: string, description?: string, id = `${name}-id`): Drive {
  return { id, name, description, createdAt: "2026-01-01T00:00:00Z" };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "promptctx-"));
  getDrivesForWorkspace.mockReset();
  getDrivesForWorkspace.mockReturnValue([]);
  isCallee.mockReset();
  isCallee.mockReturnValue(false);
  listSecretMeta.mockReset();
  listSecretMeta.mockReturnValue([]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildWorkspacePromptInputs", () => {
  it("returns trimmed AGENTS.md content when the file exists", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "\n  # House rules\nBe nice.\n  ");
    const { agentsContent } = buildWorkspacePromptInputs("ws1", dir);
    expect(agentsContent).toBe("# House rules\nBe nice.");
  });

  it("leaves agentsContent undefined when AGENTS.md is missing", () => {
    const { agentsContent } = buildWorkspacePromptInputs("ws1", dir);
    expect(agentsContent).toBeUndefined();
  });

  it("leaves drivesInfo undefined when no drives are connected", () => {
    const { drivesInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(drivesInfo).toBeUndefined();
  });

  it("builds a drives block listing each connected drive and the one-home rule", () => {
    getDrivesForWorkspace.mockReturnValue([drive("shared", "team files"), drive("scratch")]);
    const { drivesInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(getDrivesForWorkspace).toHaveBeenCalledWith("ws1");
    expect(drivesInfo).toContain("# Connected drives");
    expect(drivesInfo).toContain("- shared (id: shared-id) — team files");
    expect(drivesInfo).toContain("- scratch (id: scratch-id)"); // no description → no em dash
    expect(drivesInfo).not.toContain("scratch-id) —");
    expect(drivesInfo).toContain("After uploading a file to a drive, delete your local copy");
    expect(drivesInfo).toContain("After downloading a file from a drive, delete your local copy");
  });

  it("omits the skill-contract drive nudge when the workspace is not a callee", () => {
    getDrivesForWorkspace.mockReturnValue([drive("shared")]);
    isCallee.mockReturnValue(false);
    const { drivesInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(drivesInfo).not.toContain("declare a skill that exchanges files");
  });

  it("appends the skill-contract drive nudge only when the workspace is both drive-connected and a callee", () => {
    getDrivesForWorkspace.mockReturnValue([drive("shared")]);
    isCallee.mockReturnValue(true);
    const { drivesInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(drivesInfo).toContain("declare a skill that exchanges files");
    expect(drivesInfo).toContain("drive_id + input_path");
    expect(drivesInfo).toContain("drive_id + output_path");
  });

  it("leaves calleeInfo undefined when the workspace is not a callee", () => {
    const { calleeInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(isCallee).toHaveBeenCalledWith("ws1");
    expect(calleeInfo).toBeUndefined();
  });

  it("includes the callee guidance block when the workspace is a callee", () => {
    isCallee.mockReturnValue(true);
    const { calleeInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(calleeInfo).toContain("# Being called by other agents");
    expect(calleeInfo).toContain("skills/example-skill.json.template");
  });

  it("gathers AGENTS.md and drives independently in one call", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "rules");
    getDrivesForWorkspace.mockReturnValue([drive("d1")]);
    const inputs = buildWorkspacePromptInputs("ws1", dir);
    expect(inputs.agentsContent).toBe("rules");
    expect(inputs.drivesInfo).toContain("- d1");
  });

  it("lists each secret's allowed hosts and proxy-compatible usage guidance", () => {
    listSecretMeta.mockReturnValue([{ name: "VERCEL_TOKEN", domains: ["api.vercel.com"], createdAt: "2026-01-01" }]);
    const { secretsInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(secretsInfo).toContain("VERCEL_TOKEN → api.vercel.com");
    expect(secretsInfo).toContain("never print them");
    expect(secretsInfo).toContain("before making a request");
  });
});
