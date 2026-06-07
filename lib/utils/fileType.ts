// Shared utility — no Node.js imports, safe for client components and API routes.

export type RuntimeKey =
  | "python" | "python3" | "node" | "bash" | "sh"
  | "go_run" | "ruby" | "php" | "perl" | "deno_run"
  | "java_jar" | "dotnet";

// Extension (lowercase, no dot) → server dispatch runtime.
// Eye (hidden) is blocked for all of these: the Linux kernel cannot exec an interpreted
// script without read permission (needs shebang + file body).
const EXTENSION_TO_RUNTIME: Readonly<Record<string, RuntimeKey>> = {
  sh: "sh",   bash: "bash",  zsh: "bash",
  py: "python3",  pyw: "python3",
  js: "node", mjs: "node",  cjs: "node",
  ts: "node", mts: "node",  cts: "node",
  rb:  "ruby",
  php: "php",
  pl:  "perl", pm: "perl",
  go:  "go_run",
  jar: "java_jar",
  cs:  "dotnet", dll: "dotnet",
};

// Scripts with no dispatch runtime on this server — Eye is still blocked for them.
const SCRIPT_NO_RUNTIME: ReadonlySet<string> = new Set(["ps1", "psm1", "bat", "cmd", "kts"]);

const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...Object.keys(EXTENSION_TO_RUNTIME),
  ...SCRIPT_NO_RUNTIME,
]);

// Returns true when the filename's extension indicates an executable script.
// Case-insensitive; accepts a full path or a bare filename.
export function isExecutable(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return false;
  return EXECUTABLE_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}
