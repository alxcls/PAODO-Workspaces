import type { ToolStatus } from "../workspace/usageStore";

// Classifies a tool's final result string. Thrown errors and unknown tools are already turned
// into "Error: …" strings at the call site, so reading the final string covers every case.
// Every tool honors the "Error:"/"Permission denied:" failure convention; the A2A non-terminal
// retry state is tagged "Needs input:".
export function classifyToolStatus(resultStr: string): ToolStatus {
  if (/^Needs input:/.test(resultStr)) return "needs_input";
  if (/^(Error\b|Error \(|Permission denied)/.test(resultStr)) return "error";
  return "ok";
}
