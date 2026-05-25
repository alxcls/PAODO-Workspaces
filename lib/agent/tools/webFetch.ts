// Agent tool that fetches a URL and returns its content as plain text.
// Strips scripts, styles, and HTML tags from HTML responses. Enforces HTTPS and caps output at 20 000 characters.
// Higher than the general tool-result cap (10k) because web pages are dense and need more room to be useful.
import { tool } from "@langchain/core/tools";
import { z } from "zod";

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const BLOCKED_HOST = /^(localhost|.*\.local)(:\d+)?$|^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function assertPublicUrl(rawUrl: string): string {
  const finalUrl = rawUrl.startsWith("http://") ? rawUrl.replace("http://", "https://") : rawUrl;
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
  if (BLOCKED_HOST.test(parsed.hostname)) throw new Error("Blocked internal address");
  return finalUrl;
}

export function buildWebFetchTool() {
  return tool(
    async ({ url, prompt }) => {
      try {
        const finalUrl = assertPublicUrl(url);
        const res = await fetch(finalUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ShellCopilot/1.0)" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} — ${finalUrl}`;
        const contentType = res.headers.get("content-type") ?? "";
        let text = await res.text();
        if (contentType.includes("text/html")) text = htmlToText(text);
        const MAX_CHARS = 20_000;
        const capped = text.length > MAX_CHARS
          ? text.slice(0, MAX_CHARS) + `\n\n[content truncated — showing first ${MAX_CHARS} chars]`
          : text;
        return prompt
          ? `Fetched: ${finalUrl}\nPrompt: ${prompt}\n\n${capped}`
          : `Fetched: ${finalUrl}\n\n${capped}`;
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "http_get",
      description: `Make an HTTP GET request to any public URL and return the response body as plain text.
This is a server-side request executed by the platform — always call this tool when the user provides a URL or asks for web content.
HTTP URLs are automatically upgraded to HTTPS.
Use the prompt field to describe what to extract from the response.
For GitHub repos/PRs/issues, prefer gh CLI via execute_command instead.`,
      schema: z.object({
        url: z.string().describe("Fully-formed URL to fetch"),
        prompt: z.string().optional().describe("What to extract or focus on from the page"),
      }),
    }
  );
}
