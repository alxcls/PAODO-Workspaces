import type { Instrumentation } from "next";

// Next catches exceptions raised by route handlers and server rendering internally. The custom
// HTTP server can see the resulting 500 status, but not the original exception; this hook preserves
// that diagnostic in the durable operational log.
//
// Next also builds this module for Edge, where the filesystem-backed logger cannot resolve. The
// import must therefore sit *inside* a positive `=== "nodejs"` branch: Next inlines NEXT_RUNTIME per
// bundle, and webpack drops a dynamic import in a statically-false branch while it is parsing. The
// equivalent early-return guard reads the same but does not work — the import stays reachable in the
// AST, so it lands in the Edge module graph and every dev request 500s on "Can't resolve 'fs'".
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { logNextRequestError } = await import("./instrumentation.node");
    return logNextRequestError(err, request, context);
  }
};
