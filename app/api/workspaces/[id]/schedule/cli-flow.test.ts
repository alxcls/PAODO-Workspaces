// Exercise the actual CLI executable over HTTP against the real schedule routes/operations.
// Only workspace lookup and persistence are isolated; no agent runner is started.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ScheduleEntry } from "@/lib/schedules/types";

const h = vi.hoisted(() => ({ entry: null as ScheduleEntry | null, requests: [] as string[] }));
const id = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({
    getWorkspace: (value: string) => (value === "11111111-1111-4111-8111-111111111111" ? { id: value } : undefined),
  }),
}));
vi.mock("@/lib/infra/schedules/scheduleStore", () => ({
  getSchedule: () => h.entry,
  setSchedule: (entry: ScheduleEntry) => {
    h.entry = entry;
  },
}));
import { GET, PATCH, PUT } from "./route";

const executable = path.resolve("cli/bin/paodo.mjs");
let endpoint: string;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (req.headers.authorization !== "Bearer cli-local-test") {
      res.writeHead(401).end();
      return;
    }
    h.requests.push(`${req.method} ${req.url}`);
    const handler = req.method === "GET" ? GET : req.method === "PATCH" ? PATCH : PUT;
    const request = new Request(`${endpoint}${req.url}`, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body } : {}),
    });
    const response = await handler(request as never, { params: Promise.resolve({ id: req.url!.split("/")[3] }) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [executable, ...args],
      {
        env: { ...process.env, PAODO_ENDPOINT: endpoint, PAODO_TOKEN: "cli-local-test" },
        timeout: 5000,
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr }),
    );
  });
}
const schedule = (...args: string[]) => cli("workspace", "schedule", ...args);

describe.skipIf(!existsSync(executable))("CLI schedule workflow over HTTP", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    endpoint = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports missing configuration when disabling a never-configured job", async () => {
    const result = await schedule("set", id, "enabled=false");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("intervalValue is required");
    expect(h.entry).toBeNull();
  });

  it("supports inspecting, creating a draft, enabling, editing, clearing an end, and disabling", async () => {
    const empty = await schedule("get", id);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('state : "disabled"');
    const incomplete = await schedule("set", id, "enabled=true");
    expect(incomplete.code).toBe(1);
    expect(incomplete.stderr).toContain("intervalValue is required");
    expect(incomplete.stderr).toContain("timezone is required");

    const draft = await schedule(
      "set",
      id,
      "intervalValue=1",
      "intervalUnit=day",
      "startAt=2099-01-01T09:00",
      "timezone=Europe/Paris",
      "prompt=Summarize changes = daily",
    );
    expect(draft.code).toBe(0);
    expect(h.entry).toMatchObject({ enabled: false, prompt: "Summarize changes = daily" });
    expect((await schedule("get", id)).stdout).toMatch(/createdAt : "[\d-]+T[\d:]+[+-]\d\d:\d\d"/);
    expect((await schedule("set", id, "enabled=true")).code).toBe(0);
    expect(h.entry?.nextRunAt).toBe("2099-01-01T09:00+01:00");
    const historyId = h.entry?.id;
    expect((await schedule("set", id, "endAt=2099-02-01T00:00")).code).toBe(0);
    expect(h.entry?.endAt).toBe("2099-02-01T00:00");
    expect((await schedule("set", id, "endAt=")).code).toBe(0);
    expect(h.entry?.endAt).toBeUndefined();
    expect((await schedule("set", id, "enabled=false")).code).toBe(0);
    expect(h.entry).toMatchObject({
      id: historyId,
      enabled: false,
      nextRunAt: null,
      prompt: "Summarize changes = daily",
    });
  }, 15000);

  it("rejects the original freeze command while enabling and remains responsive", async () => {
    const before = structuredClone(h.entry);
    const result = await schedule("set", id, "intervalValue=1e300", "enabled=true");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("<= 10000");
    expect(h.entry).toEqual(before);
    expect((await schedule("get", id)).code).toBe(0);
  });

  it.each([
    "intervalValue=1e300",
    "intervalValue=1e9",
    "intervalValue=1e12",
    "intervalValue=1.5",
    "intervalValue=0",
    "intervalUnit=month",
    "timezone=Mars/Phobos",
    "startAt=2099-01-01T09:00Z",
    "enabled=yes",
    "enabld=true",
  ])("rejects %s with a nonzero exit and unchanged state", async (argument) => {
    const before = structuredClone(h.entry);
    const result = await schedule("set", id, argument);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("SCHEDULE_INVALID");
    expect(h.entry).toEqual(before);
  });

  it.each([["enable"], ["intervalValue=2", "intervalValue=3"], ["--dry-run", "enabled=true"]])(
    "rejects usage mistakes before sending HTTP: %s",
    async (...args) => {
      const count = h.requests.length;
      const result = await schedule("set", id, ...args);
      expect(result.code).toBe(1);
      expect(h.requests).toHaveLength(count);
    },
  );

  it("preserves concurrent changes in ten rounds", async () => {
    for (let i = 1; i <= 10; i++) {
      const results = await Promise.all([
        schedule("set", id, `prompt=round ${i}`),
        schedule("set", id, `intervalValue=${i}`),
      ]);
      expect(results.map((result) => result.code)).toEqual([0, 0]);
      expect(h.entry).toMatchObject({ prompt: `round ${i}`, intervalValue: i });
    }
    expect(h.requests.filter((r) => r.startsWith("PUT"))).toEqual([]);
  }, 15000);

  it("explains a missing workspace", async () => {
    const result = await schedule("get", "22222222-2222-4222-8222-222222222222");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NOT_FOUND");
  });
});
