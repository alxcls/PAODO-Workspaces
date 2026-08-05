// Flatten a provider message's content into text.
//
// Newer models return content as an array of typed blocks instead of a plain string, so every
// consumer that wants the text of a message has to fold those blocks. Four places were folding them
// independently — the streaming turn, the stored-history projection, the compaction summary, and the
// dashboard's system-prompt view — which is three chances for them to disagree about what the same
// message says.
//
// Deliberately dependency-free, no LangChain types: the reason the duplicate in
// messageSerialization.ts existed at all was to keep that module off the agent runtime's import
// chain, so a shared home is only usable if importing it stays free.

/** A text-bearing block, whatever else the provider attached to it. */
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text ?? "");
  return "";
}

/**
 * The message's text as one run, blocks concatenated with no separator — the provider split them at
 * arbitrary points mid-sentence while streaming, so anything inserted between them lands inside a
 * word. Non-text blocks (reasoning, tool calls, images) contribute nothing.
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockText).join("");
}

/**
 * The message's text with each block as its own paragraph, for content whose blocks are authored
 * sections rather than stream fragments — the system prompt, whose blocks are the model config, the
 * AGENTS.md body, and the drives and secrets listings. Empty blocks are dropped so a section that
 * rendered to nothing does not leave a blank gap.
 */
export function contentToParagraphs(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockText).filter(Boolean).join("\n\n");
}
