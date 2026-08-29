// Locks the atomicity rule: a set's members go up before its commit marker, and a member failure
// stops the push before the marker is ever written. A fake push records order, so no network or tar.
import { describe, it, expect } from "vitest";
import { pushSet } from "./setTransfer";
import { SET_MANIFEST_MEMBER, type BackupSet } from "../../archive/setManifest";

function manifest(): BackupSet {
  return {
    schemaVersion: 1,
    kind: "set",
    id: "abc123",
    instance: "test-deployment",
    source: { deployment: "test-deployment", host: "h", capturedAt: "2026-01-02T03:04:05.000Z", paodoCommit: null },
    entries: [
      { kind: "graph", file: "graph.tar", bytes: 1, sha256: "a" },
      { kind: "database", file: "database.tar", bytes: 1, sha256: "b" },
      { kind: "workspace", file: "ws.tar", bytes: 1, sha256: "c", workspaceId: "ws-1" },
    ],
  };
}

describe("pushSet ordering", () => {
  it("pushes every member before the commit marker", async () => {
    const keys: string[] = [];
    const push = async (_local: string, key: string) => {
      keys.push(key);
      return `s3://bucket/${key}`;
    };

    const urls = await pushSet("/set", manifest(), "test-deployment/stamp-abc123", push);

    expect(keys).toEqual([
      "test-deployment/stamp-abc123/graph.tar",
      "test-deployment/stamp-abc123/database.tar",
      "test-deployment/stamp-abc123/ws.tar",
      `test-deployment/stamp-abc123/${SET_MANIFEST_MEMBER}`,
    ]);
    expect(urls).toHaveLength(4);
  });

  it("never pushes the marker when a member fails", async () => {
    const keys: string[] = [];
    const push = async (_local: string, key: string) => {
      keys.push(key);
      if (key.endsWith("database.tar")) throw new Error("network died");
      return `s3://bucket/${key}`;
    };

    await expect(pushSet("/set", manifest(), "test-deployment/stamp-abc123", push)).rejects.toThrow("network died");
    expect(keys.some((k) => k.endsWith(SET_MANIFEST_MEMBER))).toBe(false);
  });
});
