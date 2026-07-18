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
  // Routine records use Pino's asynchronous SonicBoom destination. Tests explicitly flush that
  // buffer, whose synchronous drain uses fs.writeSync; intercept fd 1 only and let other writes
  // through. The separate process-boundary test below verifies the real exit path.
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
    const { createAuditLogger, createLogger, flushLogsSync } = await import("./logger");
    createLogger("test").warn({ workspaceId: "ws-1" }, "operational warning");
    createAuditLogger("test").info({ workspaceId: "ws-1", event: "key_rotated" }, "key rotated");
    flushLogsSync();

    expect(written).toEqual([
      expect.objectContaining({ level: 40, context: "test", msg: "operational warning" }),
      expect.objectContaining({
        level: 30,
        context: "test",
        event: "key_rotated",
        outcome: "event_recorded",
        msg: "key rotated",
        audit: true,
      }),
    ]);
    expect(written[0].audit).toBeUndefined();
  });

  it("adds a stable event and outcome to legacy message-only records", async () => {
    const { createLogger, flushLogsSync } = await import("./logger");
    createLogger("agent").info("agent run started");
    createLogger("agent").warn({ workspaceId: "ws-1" }, "agent stream timed out");
    flushLogsSync();

    expect(written[0]).toEqual(
      expect.objectContaining({
        context: "agent",
        event: "agent_run_started",
        outcome: "event_recorded",
        msg: "agent run started",
      }),
    );
    expect(written[1]).toEqual(
      expect.objectContaining({
        context: "agent",
        workspaceId: "ws-1",
        event: "agent_stream_timed_out",
        outcome: "attention_required",
        msg: "agent stream timed out",
      }),
    );
  });

  it("preserves explicit semantic event and outcome fields", async () => {
    const { createLogger, flushLogsSync } = await import("./logger");
    createLogger("test").error(
      { event: "workspace_create_failed", outcome: "workspace_not_created" },
      "failed to create workspace",
    );
    flushLogsSync();

    expect(written[0]).toEqual(
      expect.objectContaining({
        event: "workspace_create_failed",
        outcome: "workspace_not_created",
      }),
    );
  });

  it("redacts common credential fields", async () => {
    const { createAuditLogger, flushLogsSync } = await import("./logger");
    createAuditLogger("test").info(
      { token: "top-secret", headers: { authorization: "Bearer top-secret" } },
      "redacted event",
    );
    flushLogsSync();

    const [record] = written;
    expect(record.token).toBe("[Redacted]");
    expect((record.headers as { authorization: string }).authorization).toBe("[Redacted]");
  });

  it("redacts credentials embedded in errors, stderr, agent output, and the message", async () => {
    const { createLogger, flushLogsSync } = await import("./logger");
    const bearer = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const openAiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz";
    const mcpSecret = `mcp_${"a".repeat(64)}`;
    const proxyPassword = "proxy-password-abcdefghijklmnopqrstuvwxyz";

    createLogger("test").error(
      {
        err: new Error(`provider rejected Authorization: Bearer ${bearer}`),
        stderr: `git failed for https://workspace:${proxyPassword}@example.com/repo`,
        agentError: `Invalid API key: ${openAiKey}`,
        event: "mcp_auth_unauthorized",
      },
      `MCP request failed with secret=${mcpSecret}`,
    );
    flushLogsSync();

    const serialized = JSON.stringify(written[0]);
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain(openAiKey);
    expect(serialized).not.toContain(mcpSecret);
    expect(serialized).not.toContain(proxyPassword);
    expect(serialized).toContain("[Redacted]");

    const record = written[0] as {
      err: { type: string; message: string; stack: string };
      stderr: string;
      agentError: string;
      msg: string;
    };
    expect(record.err.type).toBe("Error");
    expect(record.err.message).toBe("provider rejected Authorization: Bearer [Redacted]");
    expect(record.err.stack).toContain("provider rejected Authorization: Bearer [Redacted]");
    expect(record.stderr).toContain("https://workspace:[Redacted]@example.com/repo");
    expect(record.agentError).toBe("Invalid API key: [Redacted]");
    expect(record.msg).toBe("MCP request failed with secret=[Redacted]");
    expect(written[0].event).toBe("mcp_auth_unauthorized");
  });

  it("attaches request context across asynchronous work", async () => {
    const { createLogger, flushLogsSync, runWithLogContext } = await import("./logger");
    const log = createLogger("test");

    await runWithLogContext({ requestId: "request-1", method: "POST", pathname: "/api/workspaces" }, async () => {
      await Promise.resolve();
      log.warn({ workspaceId: "ws-1" }, "request-scoped warning");
    });
    flushLogsSync();

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
    const { createLogger, flushLogsSync, runWithLogContext } = await import("./logger");
    const log = createLogger("test");

    runWithLogContext({ requestId: "request-1" }, () => log.warn("inside"));
    log.warn("outside");
    flushLogsSync();

    expect(written[0].requestId).toBe("request-1");
    expect(written[1].requestId).toBeUndefined();
  });

  it("buffers routine records until an asynchronous drain or explicit flush", async () => {
    const { createLogger, flushLogsSync } = await import("./logger");
    createLogger("test").info("routine record");

    expect(written).toEqual([]);
    flushLogsSync();
    expect(written[0]).toEqual(expect.objectContaining({ context: "test", msg: "routine record" }));
  });

  // Regression: process.exit() stops the event loop before an asynchronous stdout queue drains.
  // exitAfterLogs synchronously drains the final record at the intentional exit boundary, while
  // routine writes above remain asynchronous. Spawned because the failure crosses a process edge.
  it("does not lose a record when the process exits immediately after writing", () => {
    const script = path.join(mkdtempSync(path.join(tmpdir(), "paodo-logexit-")), "exit.ts");
    const loggerModule = path.join(__dirname, "logger.ts");
    writeFileSync(
      script,
      `import { createLogger, exitAfterLogs } from ${JSON.stringify(loggerModule)};\n` +
        `createLogger("test").fatal({ big: "x".repeat(200000) }, "process exiting");\n` +
        `exitAfterLogs(1);\n`,
    );

    // stdio pipe, not inherit — a pipe is what a container's stdout is, and what truncated.
    const { stdout } = spawnSync(process.execPath, ["--import", "tsx", script], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    rmSync(path.dirname(script), { recursive: true, force: true });

    expect(stdout.length).toBeGreaterThan(200_000);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!).msg).toBe("process exiting");
  }, 30_000);

  it("honours LOG_LEVEL", async () => {
    process.env.LOG_LEVEL = "error";

    const { createLogger, flushLogsSync } = await import("./logger");
    const log = createLogger("test");
    log.warn("dropped");
    log.error("kept");
    flushLogsSync();

    expect(written).toHaveLength(1);
    expect(written[0].msg).toBe("kept");
  });
});
