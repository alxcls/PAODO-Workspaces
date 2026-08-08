import { describe, expect, it } from "vitest";
import { createWorkspace } from "./create";
import type { Workspace } from "@/lib/workspace/types";

const workspace: Workspace = {
  id: "ws-1",
  name: "Alpha",
  dir: "/private/alpha",
  createdAt: new Date("2026-01-02T03:04:05Z"),
  description: "First workspace",
  maxIterations: 30,
  maxRunMinutes: 20,
  internetAccess: false,
};

describe("workspace creation", () => {
  it("creates a workspace with a canonical name and returns its public summary", async () => {
    const create = async (name: string): Promise<Workspace> => {
      expect(name).toBe("Alpha");
      return { ...workspace, name };
    };

    await expect(createWorkspace({ name: "  Alpha  " }, { createWorkspace: create })).resolves.toEqual({
      id: "ws-1",
      name: "Alpha",
      description: "First workspace",
    });
  });

  it("rejects an invalid workspace name before touching the store", async () => {
    const create = async (): Promise<Workspace> => {
      throw new Error("must not create an invalid workspace");
    };

    await expect(createWorkspace({ name: "team/invoices" }, { createWorkspace: create })).rejects.toMatchObject({
      code: "WORKSPACE_NAME_INVALID",
    });
  });
});
