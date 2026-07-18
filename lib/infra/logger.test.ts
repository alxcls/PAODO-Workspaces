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

/** Durable writes are buffered, so every assertion about file contents has to flush first. */
function readRecords(file: string): Record<string, unknown>[] {
  const contents = readFileSync(file, "utf-8").trim();
  if (!contents) return [];
  return contents.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("logger", () => {
  it("separates operational warnings from info-level security audit events", async () => {
    const operationalFile = path.join(root, "operational.log");
    const securityFile = path.join(root, "security.log");
    process.env.OPERATIONAL_LOG_FILE = operationalFile;
    process.env.SECURITY_LOG_FILE = securityFile;

    const { createAuditLogger, createLogger, flushLogs } = await import("./logger");
    const log = createLogger("test");
    const audit = createAuditLogger("test");
    log.info("ordinary info");
    log.warn({ workspaceId: "ws-1" }, "operational warning");
    audit.info({ workspaceId: "ws-1", event: "key_rotated" }, "key rotated");
    flushLogs();

    expect(readRecords(operationalFile)).toEqual([
      expect.objectContaining({ level: 40, context: "test", msg: "operational warning", workspaceId: "ws-1" }),
    ]);
    expect(readRecords(securityFile)).toEqual([
      expect.objectContaining({ level: 30, context: "test", msg: "key rotated", audit: true }),
    ]);
    expect(statSync(operationalFile).mode & 0o777).toBe(0o600);
    expect(statSync(securityFile).mode & 0o777).toBe(0o600);
  });

  it("redacts common credential fields", async () => {
    const file = path.join(root, "security.log");
    process.env.SECURITY_LOG_FILE = file;

    const { createAuditLogger, flushLogs } = await import("./logger");
    createAuditLogger("test").info(
      { token: "top-secret", headers: { authorization: "Bearer top-secret" } },
      "redacted event",
    );
    flushLogs();

    const [record] = readRecords(file);
    expect(record.token).toBe("[Redacted]");
    expect((record.headers as { authorization: string }).authorization).toBe("[Redacted]");
  });

  it("attaches request context across asynchronous work", async () => {
    const file = path.join(root, "operational.log");
    process.env.OPERATIONAL_LOG_FILE = file;

    const { createLogger, flushLogs, runWithLogContext } = await import("./logger");
    const log = createLogger("test");
    await runWithLogContext({ requestId: "request-1", method: "POST", pathname: "/api/workspaces" }, async () => {
      await Promise.resolve();
      log.warn({ workspaceId: "ws-1" }, "request-scoped warning");
    });
    flushLogs();

    expect(readRecords(file)[0]).toEqual(
      expect.objectContaining({
        context: "test",
        requestId: "request-1",
        method: "POST",
        pathname: "/api/workspaces",
        workspaceId: "ws-1",
      }),
    );
  });

  it("collapses repeated warnings and reports how many it stood in for", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
    const file = path.join(root, "security.log");
    process.env.SECURITY_LOG_FILE = file;

    const { createAuditLogger, flushLogs } = await import("./logger");
    const audit = createAuditLogger("test");
    // Event names no production call site uses: the dedupe map is process-wide by design, so a
    // sibling test file logging a real event would otherwise perturb the counts here.
    const emit = () => audit.warn({ ip: "1.2.3.4", event: "dedupe_probe_alpha" }, "dedupe probe alpha");

    for (let i = 0; i < 50; i++) emit();
    flushLogs();
    // A burst of identical events costs one line, not fifty.
    expect(readRecords(file)).toHaveLength(1);

    vi.advanceTimersByTime(61_000);
    emit();
    flushLogs();

    const records = readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual(expect.objectContaining({ event: "dedupe_probe_alpha", suppressed: 49 }));
  });

  it("keeps distinct events separate while collapsing", async () => {
    const file = path.join(root, "security.log");
    process.env.SECURITY_LOG_FILE = file;

    const { createAuditLogger, flushLogs } = await import("./logger");
    const audit = createAuditLogger("test");
    audit.warn({ event: "dedupe_probe_beta" }, "dedupe probe beta");
    audit.warn({ event: "dedupe_probe_beta" }, "dedupe probe beta");
    audit.warn({ event: "dedupe_probe_gamma" }, "dedupe probe gamma");
    flushLogs();

    // Sorted by `time`, not compared in file order: flushSync writes the queued lines synchronously
    // without re-queueing a line whose async write is already in flight, so a flush on a busy event
    // loop can land the two out of order. Every record carries `time`, which is what a reader
    // actually orders by. What this test pins is the dedupe decision — beta collapses to one line
    // and gamma is not swallowed with it.
    const events = readRecords(file)
      .sort((a, b) => (a.time as number) - (b.time as number))
      .map((r) => r.event);
    expect(events).toEqual(["dedupe_probe_beta", "dedupe_probe_gamma"]);
  });

  it("never collapses info-level audit events", async () => {
    const file = path.join(root, "security.log");
    process.env.SECURITY_LOG_FILE = file;

    const { createAuditLogger, flushLogs } = await import("./logger");
    const audit = createAuditLogger("test");
    // Deliberate admin actions are low-volume and each one matters; only warn and above collapse.
    for (let i = 0; i < 3; i++) audit.info({ workspaceId: "ws-1", event: "dedupe_probe_delta" }, "dedupe probe delta");
    flushLogs();

    expect(readRecords(file)).toHaveLength(3);
  });

  it("writes durable logs whenever the file is configured, independent of NODE_ENV", async () => {
    // Gating on NODE_ENV as well would mean a stray environment silently produces no audit trail.
    vi.stubEnv("NODE_ENV", "development");
    const file = path.join(root, "security.log");
    process.env.SECURITY_LOG_FILE = file;

    const { createAuditLogger, flushLogs } = await import("./logger");
    createAuditLogger("test").info({ event: "api_key_set" }, "api key set");
    flushLogs();

    expect(readRecords(file)).toHaveLength(1);
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
