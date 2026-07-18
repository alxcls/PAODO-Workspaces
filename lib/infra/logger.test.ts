import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const originalLogLevel = process.env.LOG_LEVEL;

/** Lines pino wrote to stdout during a test, parsed back from JSON. */
let written: Record<string, unknown>[];

beforeEach(() => {
  written = [];
  vi.stubEnv("NODE_ENV", "production");
  process.env.LOG_LEVEL = "info";
  // The logger writes through a synchronous pino destination (fs.writeSync on fd 1) rather than the
  // process.stdout stream, so that a fatal record cannot be lost to an unflushed queue on exit.
  // That makes fs.writeSync the capture point; intercept fd 1 only and let anything else through.
  const realWriteSync = fs.writeSync.bind(fs);
  vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
    for (const line of String(data).split("\n").filter(Boolean)) {
      written.push(JSON.parse(line) as Record<string, unknown>);
    }
    return String(data).length;
  }) as typeof fs.writeSync);
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

  // Regression: the logger used to write to process.stdout, which queues anything past the pipe
  // buffer inside Node instead of blocking. server.ts's fatal() logs and calls process.exit(1)
  // immediately, so the queue was discarded and the record explaining the crash never arrived —
  // measured at 65,536 of 200,105 bytes in the production image. A synchronous destination has no
  // queue to lose. Spawned for real because the failure only exists across a process boundary.
  it("does not lose a record when the process exits immediately after writing", () => {
    const script = path.join(mkdtempSync(path.join(tmpdir(), "paodo-logexit-")), "exit.ts");
    const loggerModule = path.join(__dirname, "logger.ts");
    writeFileSync(
      script,
      `import { createLogger } from ${JSON.stringify(loggerModule)};\n` +
        `createLogger("test").fatal({ big: "x".repeat(200000) }, "process exiting");\n` +
        `process.exit(1);\n`,
    );

    // stdio pipe, not inherit — a pipe is what a container's stdout is, and what truncated.
    const { stdout } = spawnSync("npx", ["tsx", script], { encoding: "utf-8", stdio: "pipe" });
    rmSync(path.dirname(script), { recursive: true, force: true });

    expect(stdout.length).toBeGreaterThan(200_000);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!).msg).toBe("process exiting");
  }, 30_000);

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
