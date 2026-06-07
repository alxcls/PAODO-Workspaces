// Shared utility — no Node.js imports, safe for client components and API routes.

// ── Dispatchable runtimes ────────────────────────────────────────────────────
// One entry per runtime. RuntimeKey, RUNTIME_PREFIX, and EXTENSION_TO_RUNTIME
// are all derived — adding a new dispatchable runtime means one entry here only.

type RuntimeDef = { prefix: string[]; extensions: string[] };

const RUNTIME_DEFS = {
  // explicit-only (no auto-detected extension; user must specify runtime manually)
  python:   { prefix: ["python"],        extensions: [] },
  // auto-detected
  python3:  { prefix: ["python3"],       extensions: ["py", "pyw"] },
  node:     { prefix: ["node"],          extensions: ["js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx"] },
  bash:     { prefix: ["bash"],          extensions: ["bash", "zsh", "ksh"] },
  sh:       { prefix: ["sh"],            extensions: ["sh", "dash"] },
  go_run:   { prefix: ["go", "run"],     extensions: ["go"] },
  ruby:     { prefix: ["ruby"],          extensions: ["rb", "rake"] },
  php:      { prefix: ["php"],           extensions: ["php", "phar"] },
  perl:     { prefix: ["perl"],          extensions: ["pl", "pm", "t"] },
  deno_run: { prefix: ["deno", "run"],   extensions: ["deno"] },
  java_jar: { prefix: ["java", "-jar"],  extensions: ["jar"] },
  dotnet:   { prefix: ["dotnet"],        extensions: ["cs", "dll", "fsx", "vb"] },
  lua:      { prefix: ["lua"],           extensions: ["lua"] },
  rscript:  { prefix: ["Rscript"],       extensions: ["r"] },
  swift:    { prefix: ["swift"],         extensions: ["swift"] },
  awk:      { prefix: ["awk", "-f"],     extensions: ["awk"] },
  tcl:      { prefix: ["tclsh"],         extensions: ["tcl", "tk"] },
} satisfies Record<string, RuntimeDef>;

export type RuntimeKey = keyof typeof RUNTIME_DEFS;

// RuntimeKey → argv prefix (consumed by runKeyedScript.ts).
export const RUNTIME_PREFIX = Object.fromEntries(
  Object.entries(RUNTIME_DEFS).map(([k, v]) => [k, v.prefix])
) as Record<RuntimeKey, string[]>;

// Extension → RuntimeKey (derived; edit RUNTIME_DEFS above, not this).
const EXTENSION_TO_RUNTIME: Readonly<Record<string, RuntimeKey>> = Object.fromEntries(
  Object.entries(RUNTIME_DEFS).flatMap(([key, { extensions }]) =>
    extensions.map((ext) => [ext, key as RuntimeKey])
  )
);

// ── Recognised scripts with no dispatch runtime on this server ───────────────
// Still classified as executable (Eye blocked, Key blocked).
// Grouped by language — add a new entry or extend an existing group.

const SCRIPT_NO_RUNTIME_GROUPS: Record<string, string[]> = {
  powershell:   ["ps1", "psm1", "psd1"],
  windows:      ["bat", "cmd"],
  kotlin:       ["kt", "kts"],
  scala:        ["scala", "sc"],
  groovy:       ["groovy"],
  fish:         ["fish"],
  vbscript:     ["vbs", "vbe"],
  applescript:  ["applescript", "scpt"],
  coffeescript: ["coffee"],
  julia:        ["jl"],
  nim:          ["nim"],
  zig:          ["zig"],
  elixir:       ["ex", "exs"],
  erlang:       ["erl", "hrl"],
  haskell:      ["hs", "lhs"],
  clojure:      ["clj", "cljs", "cljc"],
  dart:         ["dart"],
  crystal:      ["cr"],
  ocaml:        ["ml", "mli"],
  vlang:        ["v"],
};

const SCRIPT_NO_RUNTIME: ReadonlySet<string> = new Set(
  Object.values(SCRIPT_NO_RUNTIME_GROUPS).flat()
);

const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...Object.keys(EXTENSION_TO_RUNTIME),
  ...SCRIPT_NO_RUNTIME,
]);

// ── Known non-executable data / document types ───────────────────────────────
// Eye is allowed; Key is blocked.
// Grouped by kind — add new types to the appropriate group.

const DATA_GROUPS: Record<string, string[]> = {
  documents: ["md", "txt", "rst", "pdf", "doc", "docx", "odt", "rtf", "tex"],
  data:      ["json", "jsonl", "ndjson", "yaml", "yml", "toml", "xml", "csv", "tsv"],
  config:    ["env", "ini", "cfg", "conf", "properties", "editorconfig", "gitignore", "dockerignore"],
  web:       ["html", "htm", "css", "sass", "scss", "less"],
  images:    ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tiff", "avif"],
  fonts:     ["ttf", "otf", "woff", "woff2", "eot"],
  archives:  ["zip", "tar", "gz", "bz2", "xz", "7z", "rar"],
  binary:    ["wasm", "bin", "exe", "so", "dylib", "a", "o"],
  misc:      ["log", "lock", "map", "patch", "diff", "pid", "sock"],
};

const DATA_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.values(DATA_GROUPS).flat()
);

// ── Public API ───────────────────────────────────────────────────────────────

// "executable" → Key allowed, Eye blocked.
// "data"       → Key blocked, Eye allowed.
// "unknown"    → Key blocked, Eye allowed (fallback to Eye side).
export type FileCategory = "executable" | "data" | "unknown";

export function getFileCategory(filename: string): FileCategory {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "unknown";
  const ext = filename.slice(dot + 1).toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(ext)) return "executable";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  return "unknown";
}

export function isExecutable(filename: string): boolean {
  return getFileCategory(filename) === "executable";
}

// Returns the dispatch runtime for a file, or undefined if not dispatchable.
export function getRuntimeKey(filename: string): RuntimeKey | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return undefined;
  return EXTENSION_TO_RUNTIME[filename.slice(dot + 1).toLowerCase()];
}
