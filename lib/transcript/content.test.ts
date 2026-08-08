import { describe, expect, it } from "vitest";
import { contentToParagraphs, contentToText } from "./content";

describe("contentToText", () => {
  it("returns a plain string unchanged", () => {
    expect(contentToText("hello")).toBe("hello");
  });

  it("concatenates block text with no separator so a split word stays whole", () => {
    expect(
      contentToText([
        { type: "text", text: "un" },
        { type: "text", text: "split" },
      ]),
    ).toBe("unsplit");
  });

  it("keeps bare string blocks", () => {
    expect(contentToText(["a", { type: "text", text: "b" }])).toBe("ab");
  });

  it("contributes nothing for blocks that carry no text", () => {
    expect(
      contentToText([
        { type: "reasoning", reasoning: "hidden" },
        { type: "text", text: "shown" },
      ]),
    ).toBe("shown");
  });

  it("treats content that is neither string nor array as empty", () => {
    expect(contentToText(undefined)).toBe("");
    expect(contentToText(null)).toBe("");
    expect(contentToText({ text: "not a block list" })).toBe("");
  });
});

describe("contentToParagraphs", () => {
  it("separates authored sections with a blank line", () => {
    expect(
      contentToParagraphs([
        { type: "text", text: "config" },
        { type: "text", text: "AGENTS.md" },
      ]),
    ).toBe("config\n\nAGENTS.md");
  });

  it("drops a section that rendered to nothing rather than leaving a gap", () => {
    expect(
      contentToParagraphs([
        { type: "text", text: "config" },
        { type: "text", text: "" },
        { type: "text", text: "end" },
      ]),
    ).toBe("config\n\nend");
  });

  it("returns a plain string prompt unchanged", () => {
    expect(contentToParagraphs("one block")).toBe("one block");
  });
});
