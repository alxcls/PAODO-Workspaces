import { describe, it, expect } from "vitest";
import { decidePreviewReaction } from "./useFileContent";

const HTML = "/data/ws/index.html";
const JS = "/data/ws/app.js";
const NONE = new Set<string>();

describe("decidePreviewReaction", () => {
  it("reloads content and preview when the open HTML file itself changes", () => {
    expect(decidePreviewReaction(HTML, [HTML], NONE)).toEqual({ reloadContent: true, reloadPreview: true });
  });

  it("reloads content but not preview for a non-HTML file changing directly", () => {
    const ts = "/data/ws/main.ts";
    expect(decidePreviewReaction(ts, [ts], NONE)).toEqual({ reloadContent: true, reloadPreview: false });
  });

  it("reloads the preview when a tag-loaded sibling asset changes (by extension)", () => {
    expect(decidePreviewReaction(HTML, [JS], NONE)).toEqual({ reloadContent: false, reloadPreview: true });
  });

  it("does NOT reload for a data file that was never fetched (no extension guess for data)", () => {
    // A JSON the preview never fetched is invisible to the tracker — no reload, no false positive.
    expect(decidePreviewReaction(HTML, ["/data/ws/haiku/x.json"], NONE)).toEqual({
      reloadContent: false,
      reloadPreview: false,
    });
  });

  it("reloads the preview when an observed data dependency changes, wherever it lives", () => {
    const dep = "/data/ws/haiku/x.json";
    expect(decidePreviewReaction(HTML, [dep], new Set([dep]))).toEqual({
      reloadContent: false,
      reloadPreview: true,
    });
  });

  it("ignores an unrelated file change (e.g. a Python script) that isn't an asset or a dependency", () => {
    expect(decidePreviewReaction(HTML, ["/data/ws/generate.py"], new Set(["/data/ws/haiku/x.json"]))).toEqual({
      reloadContent: false,
      reloadPreview: false,
    });
  });

  it("does not treat the open HTML file as its own sibling/dependency", () => {
    // Only the current file changed and it is HTML → handled by directMatch, not the sibling/dep paths.
    const res = decidePreviewReaction(HTML, [HTML], new Set([HTML]));
    expect(res).toEqual({ reloadContent: true, reloadPreview: true });
  });

  it("matches a batch where at least one path is an observed dependency", () => {
    const dep = "/data/ws/data/points.json";
    expect(decidePreviewReaction(HTML, ["/data/ws/notes.py", dep], new Set([dep]))).toEqual({
      reloadContent: false,
      reloadPreview: true,
    });
  });
});
