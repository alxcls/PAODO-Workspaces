// buildSystemPrompt renders the dynamic per-workspace pieces (AGENTS.md, drives, secrets)
// into the system message. These tests pin that EVERY piece passed in actually reaches the output —
// the regression that motivated the inputs-object signature was a caller silently dropping
// drive or secret guidance, so it never appeared in the direct-chat and dashboard prompts.

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
    const out = text(buildSystemPrompt("ws1", NO_CACHE));
    expect(out).toContain("# Environment");
    expect(out).toContain("ws1"); // workspace name line
  });

  it("renders the display name verbatim (not derived from a path)", () => {
    // The directory is keyed by an opaque id now, so the name is passed in directly; a value with a
    // space would be impossible if the prompt were still basename-ing a filesystem path.
    const out = text(buildSystemPrompt("Invoice Agent", NO_CACHE));
    expect(out).toContain("Workspace name: Invoice Agent");
  });

  it("renders every dynamic piece passed in (AGENTS.md, drives, secrets)", () => {
    const out = text(
      buildSystemPrompt("ws1", NO_CACHE, {
        agentsContent: "# House rules",
        drivesInfo: "# Connected drives\n- shared (id: shared-id)",
        secretsInfo: "# Available Secrets\n- TOKEN → example.com",
      }),
    );
    expect(out).toContain("# House rules");
    expect(out).toContain("# Connected drives");
    expect(out).toContain("# Available Secrets");
  });

  it("adds the local-copy-cleanup bullet only when a drive is connected", () => {
    const withDrive = text(
      buildSystemPrompt("ws1", NO_CACHE, { drivesInfo: "# Connected drives\n- shared (id: shared-id)" }),
    );
    expect(withDrive).toContain("A task isn't done while a file you pushed to a drive still has a stale local copy");

    const withoutDrive = text(buildSystemPrompt("ws1", NO_CACHE));
    expect(withoutDrive).not.toContain("stale local copy");
  });
});
