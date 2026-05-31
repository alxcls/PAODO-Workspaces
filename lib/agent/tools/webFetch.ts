// Agent tool that fetches a URL and returns its content as plain text.
// Strips scripts, styles, and HTML tags from HTML responses. Enforces HTTPS and caps output at 20 000 characters.
// Higher than the general tool-result cap (10k) because web pages are dense and need more room to be useful.
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
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

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("::ffff:")
  );
}

function isPrivateIP(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

async function assertPublicUrl(rawUrl: string): Promise<string> {
  const finalUrl = rawUrl.startsWith("http://") ? rawUrl.replace("http://", "https://") : rawUrl;
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");

  // WHATWG URL keeps brackets on IPv6 hostnames (e.g. [::1]) — strip them
  const hostname = parsed.hostname.replace(/^\[|\]$/, "");

  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isPrivateIP(hostname)) throw new Error("Blocked internal address");
    return finalUrl;
  }

  // Resolve hostname → IP so alternate encodings (decimal, hex) and IPv6 are caught
  let resolvedIp: string;
  try {
    ({ address: resolvedIp } = await lookup(hostname));
  } catch {
    throw new Error("Failed to resolve hostname");
  }
  if (isPrivateIP(resolvedIp)) throw new Error("Blocked internal address");

  return finalUrl;
}

export function buildWebFetchTool() {
  return tool(
    async ({ url, prompt }) => {
      try {
        const finalUrl = await assertPublicUrl(url);
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
