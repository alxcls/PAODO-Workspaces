import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDataRootAvailable,
  assertWorkspaceRegistryAvailable,
  assertWorkspaceRegistryRecords,
} from "./startupChecks";

const roots: string[] = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paodo-startup-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("assertDataRootAvailable", () => {
  it("creates and verifies a writable data root without leaving its probe behind", () => {
    const root = path.join(tempRoot(), "data");
    assertDataRootAvailable(root);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("rejects a path occupied by a regular file", () => {
    const root = path.join(tempRoot(), "data");
    fs.writeFileSync(root, "not a directory");
    expect(() => assertDataRootAvailable(root)).toThrow();
  });
});

describe("workspace registry startup validation", () => {
  const valid = [{ id: "ws-1", name: "Workspace", createdAt: "2026-01-01T00:00:00.000Z" }];

  it("accepts a missing registry as a first run and accepts valid records", () => {
    const root = tempRoot();
    expect(() => assertWorkspaceRegistryAvailable(root)).not.toThrow();
    fs.writeFileSync(path.join(root, ".workspaces.json"), JSON.stringify(valid));
    expect(() => assertWorkspaceRegistryAvailable(root)).not.toThrow();
  });

  it("rejects corrupt JSON and structurally invalid records", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, ".workspaces.json"), "{");
    expect(() => assertWorkspaceRegistryAvailable(root)).toThrow();
    expect(() => assertWorkspaceRegistryRecords({})).toThrow(/JSON array/);
    expect(() => assertWorkspaceRegistryRecords([{ id: "ws-1", name: "Workspace" }])).toThrow(/createdAt/);
  });
});
