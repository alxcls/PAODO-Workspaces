// Human-facing descriptions of a tool call. Both the live chat stream and the server-side
// projection of stored history render through these, so a change here shows up on every surface.
import { describe, it, expect } from "vitest";
import { toolLabel, toolArgSummary } from "./toolDisplay";

describe("toolLabel", () => {
  // Known tools get friendly labels; unknown ones fall back to a humanized name.
  it("maps known tools and humanizes unknown ones", () => {
    expect(toolLabel("file_read")).toBe("Reading file");
    expect(toolLabel("some_new_tool")).toBe("some new tool");
  });
});

describe("toolArgSummary", () => {
  it("summarizes each known tool by its most identifying argument", () => {
    expect(toolArgSummary("execute_command", { command: "ls -la" })).toBe("ls -la");
    expect(toolArgSummary("file_read", { file_path: "src/index.ts" })).toBe("src/index.ts");
    expect(toolArgSummary("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolArgSummary("http_get", { url: "https://example.com" })).toBe("https://example.com");
  });

  // list_directory with no dir_path means the workspace root, which reads better as "." than "".
  it("falls back to '.' for a rootless list_directory", () => {
    expect(toolArgSummary("list_directory", {})).toBe(".");
    expect(toolArgSummary("list_directory", { dir_path: "lib" })).toBe("lib");
  });

  it("renders call_agent as a target, with the action only when present", () => {
    expect(toolArgSummary("call_agent", { workspace: "sales" })).toBe("→ sales");
    expect(toolArgSummary("call_agent", { workspace: "sales", action: "summarize" })).toBe("→ sales · summarize");
  });

  // An unmapped tool, or a mapped one whose argument is absent, contributes no summary line rather
  // than rendering "undefined" into a chat bubble.
  it("returns an empty summary for unknown tools and missing arguments", () => {
    expect(toolArgSummary("some_new_tool", { anything: 1 })).toBe("");
    expect(toolArgSummary("file_read", {})).toBe("");
  });
});
