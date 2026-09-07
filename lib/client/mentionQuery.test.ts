// Invariant: the composer must open the mention popup only for an "@" that begins a word and close
// it the moment whitespace follows, and insertion must land the caret after the inserted token.
// Bug class guarded: mentions firing mid-word (emails, "a@b"), or a wrong slice corrupting the draft.

import { describe, it, expect } from "vitest";
import { activeMention, applyMention } from "./mentionQuery";

describe("activeMention", () => {
  it("opens for a bare @ at text start", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("opens after whitespace and captures the typed query", () => {
    const text = "Fix @doc/api";
    expect(activeMention(text, text.length)).toEqual({ start: 4, query: "doc/api" });
  });

  it("does not fire mid-word (e.g. an email)", () => {
    const text = "ping me@host";
    expect(activeMention(text, text.length)).toBeNull();
  });

  it("closes once whitespace follows the mention", () => {
    const text = "@doc/api done";
    expect(activeMention(text, text.length)).toBeNull();
  });

  it("tracks the mention at the caret when it sits mid-sentence", () => {
    const text = "see @src/a and @lib/b here";
    const caret = text.indexOf("@lib/b") + "@lib/b".length;
    expect(activeMention(text, caret)).toEqual({ start: 15, query: "lib/b" });
  });
});

describe("applyMention", () => {
  it("replaces the query with @path + trailing space and moves the caret past it", () => {
    const text = "Fix @doc/ap";
    const res = applyMention(text, text.length, 4, "doc/api/auth.ts", false);
    expect(res.text).toBe("Fix @doc/api/auth.ts ");
    expect(res.caret).toBe(res.text.length);
  });

  it("appends a slash for a directory", () => {
    const res = applyMention("@sr", 3, 0, "src", true);
    expect(res.text).toBe("@src/ ");
    expect(res.caret).toBe("@src/ ".length);
  });

  it("preserves text after the caret when the mention is mid-sentence", () => {
    const text = "see @sr here";
    const caret = "see @sr".length;
    const res = applyMention(text, caret, 4, "src/main.ts", false);
    expect(res.text).toBe("see @src/main.ts  here");
    expect(res.caret).toBe("see @src/main.ts ".length);
  });
});
