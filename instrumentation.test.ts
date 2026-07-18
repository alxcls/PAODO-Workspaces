import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("./lib/infra/logger", () => ({
  createLogger: () => ({ error: mocks.error }),
}));

import { onRequestError } from "./instrumentation";

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.error.mockClear();
});

describe("Next.js request-error instrumentation", () => {
  it("logs Node.js exceptions with route context and request correlation without retaining the query", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const err = new Error("route exploded");
    await onRequestError(
      err,
      {
        path: "/api/workspaces/ws-1?token=do-not-log",
        method: "POST",
        headers: { "x-request-id": "request-1" },
      },
      {
        routerKind: "App Router",
        routePath: "/api/workspaces/[id]",
        routeType: "route",
        revalidateReason: undefined,
      },
    );

    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err,
        requestId: "request-1",
        method: "POST",
        pathname: "/api/workspaces/ws-1",
        routerKind: "App Router",
        routePath: "/api/workspaces/[id]",
        routeType: "route",
      }),
      "unhandled Next.js request error",
    );
  });

  it("does nothing outside the Node.js runtime", async () => {
    // The Edge bundle has no filesystem, so the logger must not be reached there. The guard is also
    // what lets webpack drop the import while parsing the Edge bundle — see instrumentation.ts.
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await onRequestError(new Error("boom"), { path: "/", method: "GET", headers: {} }, {
      routerKind: "App Router",
      routePath: "/",
      routeType: "route",
      revalidateReason: undefined,
    } as never);

    expect(mocks.error).not.toHaveBeenCalled();
  });
});
