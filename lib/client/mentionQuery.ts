// Caret-anchored parsing of an "@mention" being typed in the composer. Kept pure and separate from
// React so the boundary rules (where a mention starts, when it closes) can be pinned by unit tests.

export interface ActiveMention {
  /** Index of the triggering "@" in the text. */
  start: number;
  /** The characters typed after "@", up to the caret. */
  query: string;
}

/** True when an "@" at `index` begins a mention: it sits at text start or right after whitespace. */
function isMentionStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return /\s/.test(text[index - 1]);
}

/**
 * The mention the caret is currently inside, or null. Scans left from the caret to the nearest "@"
 * with no intervening whitespace; that "@" must itself begin a mention. Whitespace between "@" and
 * the caret means the mention has closed.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (/\s/.test(ch)) return null;
    if (ch === "@") {
      if (!isMentionStart(text, i)) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
  }
  return null;
}

export interface AppliedMention {
  text: string;
  caret: number;
}

/**
 * Replace the mention starting at `start` (through the caret) with `@path` and a trailing space,
 * appending "/" for a directory. Returns the new text and the caret position after the space.
 */
export function applyMention(
  text: string,
  caret: number,
  start: number,
  path: string,
  isDirectory: boolean,
): AppliedMention {
  const token = `@${path}${isDirectory ? "/" : ""} `;
  const next = text.slice(0, start) + token + text.slice(caret);
  return { text: next, caret: start + token.length };
}
