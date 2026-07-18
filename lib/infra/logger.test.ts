import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalLogLevel = process.env.LOG_LEVEL;

/** Lines pino wrote to stdout during a test, parsed back from JSON. */
let written: Record<string, unknown>[];

beforeEach(() => {
  written = [];
  vi.stubEnv("NODE_ENV", "production");
  process.env.LOG_LEVEL = "info";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(JSON.parse(String(chunk)) as Record<string, unknown>);
    return true;
  });
  vi.resetModules();
});

afterEach(() => {
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("logger", () => {
  it("tags audit events so they can be filtered out of the same stream", async () => {
    const { createAuditLogger, createLogger } = await import("./logger");
    createLogger("test").warn({ workspaceId: "ws-1" }, "operational warning");
    createAuditLogger("test").info({ workspaceId: "ws-1", event: "key_rotated" }, "key rotated");

    expect(written).toEqual([
      expect.objectContaining({ level: 40, context: "test", msg: "operational warning" }),
      expect.objectContaining({ level: 30, context: "test", msg: "key rotated", audit: true }),
    ]);
    expect(written[0].audit).toBeUndefined();
  });

  it("redacts common credential fields", async () => {
    const { createAuditLogger } = await import("./logger");
    createAuditLogger("test").info(
      { token: "top-secret", headers: { authorization: "Bearer top-secret" } },
      "redacted event",
    );

    const [record] = written;
    expect(record.token).toBe("[Redacted]");
    expect((record.headers as { authorization: string }).authorization).toBe("[Redacted]");
  });

  it("attaches request context across asynchronous work", async () => {
    const { createLogger, runWithLogContext } = await import("./logger");
    const log = createLogger("test");

    await runWithLogContext({ requestId: "request-1", method: "POST", pathname: "/api/workspaces" }, async () => {
      await Promise.resolve();
      log.warn({ workspaceId: "ws-1" }, "request-scoped warning");
    });

    expect(written[0]).toEqual(
      expect.objectContaining({
        context: "test",
        requestId: "request-1",
        method: "POST",
        pathname: "/api/workspaces",
        workspaceId: "ws-1",
      }),
    );
  });

  it("does not leak context into work that ran outside the scope", async () => {
    const { createLogger, runWithLogContext } = await import("./logger");
    const log = createLogger("test");

    runWithLogContext({ requestId: "request-1" }, () => log.warn("inside"));
    log.warn("outside");

    expect(written[0].requestId).toBe("request-1");
    expect(written[1].requestId).toBeUndefined();
  });

  it("honours LOG_LEVEL", async () => {
    process.env.LOG_LEVEL = "error";

    const { createLogger } = await import("./logger");
    const log = createLogger("test");
    log.warn("dropped");
    log.error("kept");

    expect(written).toHaveLength(1);
    expect(written[0].msg).toBe("kept");
  });
});
