import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  OPERATIONAL_LOG_FILE: process.env.OPERATIONAL_LOG_FILE,
  SECURITY_LOG_FILE: process.env.SECURITY_LOG_FILE,
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "paodo-logger-"));
  vi.stubEnv("NODE_ENV", "production");
  process.env.LOG_LEVEL = "info";
  vi.resetModules();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("logger", () => {
  it("separates operational warnings from info-level security audit events", async () => {
    const operationalFile = path.join(root, "operational.log");
    const securityFile = path.join(root, "security.log");
    process.env.OPERATIONAL_LOG_FILE = operationalFile;
    process.env.SECURITY_LOG_FILE = securityFile;

    const { createAuditLogger, createLogger } = await import("./logger");
    const log = createLogger("test");
    const audit = createAuditLogger("test");
    log.info("ordinary info");
    log.warn({ workspaceId: "ws-1" }, "operational warning");
    audit.info({ workspaceId: "ws-1", event: "key_rotated" }, "key rotated");

    const operationalRecords = readFileSync(operationalFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { level: number; context: string; msg: string; workspaceId: string });
    expect(operationalRecords).toEqual([
      expect.objectContaining({ level: 40, context: "test", msg: "operational warning", workspaceId: "ws-1" }),
    ]);

    const securityRecords = readFileSync(securityFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { level: number; context: string; msg: string; audit: boolean });
    expect(securityRecords).toEqual([
      expect.objectContaining({ level: 30, context: "test", msg: "key rotated", audit: true }),
    ]);
    expect(statSync(operationalFile).mode & 0o777).toBe(0o600);
    expect(statSync(securityFile).mode & 0o777).toBe(0o600);
  });

  it("redacts common credential fields", async () => {
    const file = path.join(root, "security.log");
    process.env.SECURITY_LOG_FILE = file;

    const { createAuditLogger } = await import("./logger");
    createAuditLogger("test").info(
      { token: "top-secret", headers: { authorization: "Bearer top-secret" } },
      "redacted event",
    );

    const record = JSON.parse(readFileSync(file, "utf-8")) as {
      token: string;
      headers: { authorization: string };
    };
    expect(record.token).toBe("[Redacted]");
    expect(record.headers.authorization).toBe("[Redacted]");
  });

  it("attaches request context across asynchronous work", async () => {
    const file = path.join(root, "operational.log");
    process.env.OPERATIONAL_LOG_FILE = file;

    const { createLogger, runWithLogContext } = await import("./logger");
    const log = createLogger("test");
    await runWithLogContext({ requestId: "request-1", method: "POST", pathname: "/api/workspaces" }, async () => {
      await Promise.resolve();
      log.warn({ workspaceId: "ws-1" }, "request-scoped warning");
    });

    const record = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect(record).toEqual(
      expect.objectContaining({
        context: "test",
        requestId: "request-1",
        method: "POST",
        pathname: "/api/workspaces",
        workspaceId: "ws-1",
      }),
    );
  });

  it("fails during initialization when the durable destination cannot be opened", async () => {
    process.env.SECURITY_LOG_FILE = root; // A directory cannot be opened as an append-only log file.
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("./logger")).rejects.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot open durable log file"),
      expect.anything(),
    );
  });
});
