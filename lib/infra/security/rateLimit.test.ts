import { afterEach, describe, expect, it, vi } from "vitest";
import { checkApiRateLimit, classifyControlPlanePolicy, RateLimiter } from "./rateLimit";

afterEach(() => vi.useRealTimers());

describe("RateLimiter", () => {
  it("allows 60 requests per minute by default", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter();

    for (let request = 1; request <= 60; request++) {
      expect(limiter.check("192.0.2.1").ok).toBe(true);
    }
    expect(limiter.check("192.0.2.1").ok).toBe(false);
  });

  it("smoothly refills capacity instead of resetting the whole window at once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limiter = new RateLimiter(60_000, 2);

    expect(limiter.check("192.0.2.2").ok).toBe(true);
    expect(limiter.check("192.0.2.2").ok).toBe(true);
    expect(limiter.check("192.0.2.2")).toMatchObject({ ok: false, retryAfter: 30 });

    vi.advanceTimersByTime(30_000);
    expect(limiter.check("192.0.2.2").ok).toBe(true);
  });

  it("keeps unrelated policy buckets independent", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(60_000, 1);

    expect(limiter.check("192.0.2.3", { bucket: "reads" }).ok).toBe(true);
    expect(limiter.check("192.0.2.3", { bucket: "reads" }).ok).toBe(false);
    expect(limiter.check("192.0.2.3", { bucket: "deletes" }).ok).toBe(true);
  });
});

describe("API rate-limit policy", () => {
  it.each([
    ["GET", "/api/workspaces/ws-1/mcp-config", "controlRead"],
    ["POST", "/api/workspaces/ws-1/mcp-config", "controlWrite"],
    ["PATCH", "/api/workspaces/ws-1", "controlWrite"],
    ["DELETE", "/api/workspaces/ws-1", "destructive"],
    ["POST", "/api/workspaces/ws-1/restore", "destructive"],
    ["POST", "/api/workspaces/ws-1/chat", "uiAgent"],
    ["POST", "/api/workspaces/ws-1/files/download", "controlRead"],
    ["POST", "/api/workspaces/ws-1/agent", null],
    ["POST", "/api/workspaces/ws-1/mcp", null],
    ["POST", "/api/workspaces/ws-1/files/upload", null],
  ] as const)("classifies %s %s as %s", (method, pathname, expected) => {
    expect(classifyControlPlanePolicy(method, pathname)).toBe(expected);
  });

  it("does not let exhausted UI-agent traffic block a workspace deletion", () => {
    vi.useFakeTimers();
    const ip = "192.0.2.44";

    for (let request = 1; request <= 30; request++) {
      expect(checkApiRateLimit(ip, "POST", "/api/workspaces/ws-1/chat").ok).toBe(true);
    }
    expect(checkApiRateLimit(ip, "POST", "/api/workspaces/ws-1/chat")).toMatchObject({
      ok: false,
      policy: "uiAgent",
    });
    expect(checkApiRateLimit(ip, "DELETE", "/api/workspaces/ws-1")).toMatchObject({
      ok: true,
      policy: "destructive",
    });
  });
});
