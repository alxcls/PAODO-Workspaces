import type { ToolStatus } from "@/lib/usage/types";

// Render a caught error as a tool result string. The leading "Error:" is load-bearing —
// classifyToolStatus below reads it to tag the call as failed (red dot in the dashboard). Every
// tool's catch tail funnels through here so the prefix and message extraction can't drift.
export function toolError(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

// Classifies a tool's final result string. Thrown errors and unknown tools are already turned
// into "Error: …" strings at the call site, so reading the final string covers every case.
// Every tool honors the "Error:"/"Permission denied:" failure convention; the A2A non-terminal
// retry state is tagged "Needs input:".
export function classifyToolStatus(resultStr: string): ToolStatus {
  if (/^Needs input:/.test(resultStr)) return "needs_input";
  if (/^(Error\b|Error \(|Permission denied)/.test(resultStr)) return "error";
  return "ok";
}
