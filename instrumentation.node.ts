import type { Instrumentation } from "next";
import { createLogger } from "./lib/infra/logger";

const log = createLogger("next");

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pathname(rawPath: string): string {
  try {
    return new URL(rawPath, "http://localhost").pathname;
  } catch {
    // Keep malformed input useful without retaining a potentially sensitive query string.
    return rawPath.split("?", 1)[0] || "/";
  }
}

export const logNextRequestError: Instrumentation.onRequestError = (err, request, context) => {
  log.error(
    {
      err,
      requestId: firstHeader(request.headers["x-request-id"]),
      method: request.method,
      pathname: pathname(request.path),
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
    },
    "unhandled Next.js request error",
  );
};
