// buildSystemPrompt renders the dynamic per-workspace pieces (AGENTS.md, drives, callee guidance)
// into the system message. These tests pin that EVERY piece passed in actually reaches the output —
// the regression that motivated the inputs-object signature was a caller silently dropping
// calleeInfo, so the callee/skills guidance never appeared in the direct-chat and dashboard prompts.

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type PromptConfig } from "./systemPrompt";

const NO_CACHE: PromptConfig = { supportsPromptCaching: false, anthropicCacheTtl1h: false };

// Flatten the SystemMessage content (an array of text blocks) into one string for assertions.
function text(msg: ReturnType<typeof buildSystemPrompt>): string {
  const content = msg.content as Array<{ text?: string }>;
  return content.map((b) => b.text ?? "").join("\n\n");
}

describe("buildSystemPrompt", () => {
  it("always includes the static environment instructions", () => {
    const out = text(buildSystemPrompt("/workspace/ws1", NO_CACHE));
    expect(out).toContain("# Environment");
    expect(out).toContain("ws1"); // workspace name line
  });

  it("renders every dynamic piece passed in (AGENTS.md, drives, callee guidance)", () => {
    const out = text(
      buildSystemPrompt("/workspace/ws1", NO_CACHE, {
        agentsContent: "# House rules",
        drivesInfo: "# Connected drives\n- shared (id: shared-id)",
        calleeInfo: "# Being called by other agents\nskills/example-skill.json.template",
      }),
    );
    expect(out).toContain("# House rules");
    expect(out).toContain("# Connected drives");
    // The piece that was being dropped — its presence here is the regression guard.
    expect(out).toContain("# Being called by other agents");
  });

  it("omits the callee block when no calleeInfo is provided", () => {
    const out = text(buildSystemPrompt("/workspace/ws1", NO_CACHE, { agentsContent: "rules" }));
    expect(out).not.toContain("# Being called by other agents");
  });
});
