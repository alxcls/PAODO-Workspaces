import type { Instrumentation } from "next";

// Next catches exceptions raised by route handlers and server rendering internally. The custom
// HTTP server can see the resulting 500 status, but not the original exception; this hook preserves
// that diagnostic in the durable operational log. Next also builds this module for Edge, so the
// filesystem-backed logger is loaded dynamically only by the Node.js instrumentation bundle.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logNextRequestError } = await import("./instrumentation.node");
  return logNextRequestError(err, request, context);
};
