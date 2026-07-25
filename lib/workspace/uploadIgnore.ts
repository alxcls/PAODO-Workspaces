// Default directories a folder upload leaves out unless the user opts back in. Keeping this as a
// short, named, easily-edited list (rather than a rule baked into the caller) makes it a one-line
// change later if experience shows a real need. The bar for this list is deliberately narrow: a
// fixed, tool-owned convention name — one no project would plausibly reuse for hand-authored content
// — that's quickly regenerated in place (npm install, pip install, ./gradlew, ...) or, if the
// toolchain isn't already in the workspace, installable by the agent first via apt_install. Kept out
// deliberately: plain-English names ("target", "bin", "obj", "build", "dist", "cache", "out", ...)
// that some ecosystem uses as a build convention but that plenty of other projects also use for
// genuinely hand-authored content (a repo's own `bin/` of maintained scripts, a "target" folder of
// business documents, ...) — excluding those by default risks silently dropping what the user meant
// to upload, which is worse than the problem this list exists to solve.
//
// Client-bundleable (no server-only imports), same convention as uploadLimits.ts, since both the
// upload preview UI and the actual upload need this list.
export const DEFAULT_IGNORED_DIR_NAMES: readonly string[] = [
  "node_modules", // JS/TS — npm/yarn/pnpm install
  "__pycache__", // Python bytecode cache — recreated the moment .py files run
  ".venv",
  "venv", // Python virtualenvs — python3 -m venv + pip install
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".angular", // framework build output — dotted, framework-owned, never hand-authored
  ".turbo",
  ".parcel-cache", // build-tool caches — same reasoning
  ".pytest_cache",
  ".mypy_cache",
  ".tox", // Python tooling caches
  ".gradle", // Gradle's own cache dir — the project's own gradlew wrapper fetches Gradle itself
];

export interface IgnorePartition<T> {
  included: T[];
  /** Ignored directory name -> the entries that fell under it. */
  excluded: Map<string, T[]>;
}

/**
 * Split `entries` into what a folder upload should send and what it should leave out, based on
 * whether any directory segment of `entry.path` matches an ignored name. Matches whole path segments
 * only — e.g. "my-node_modules-notes.txt" is never mistaken for the node_modules directory — and only
 * checks directory segments (the last segment is the file itself, never treated as a directory).
 */
export function partitionByIgnore<T extends { path: string }>(
  entries: T[],
  ignoreNames: readonly string[] = DEFAULT_IGNORED_DIR_NAMES,
): IgnorePartition<T> {
  const ignoreSet = new Set(ignoreNames);
  const included: T[] = [];
  const excluded = new Map<string, T[]>();

  for (const entry of entries) {
    const dirSegments = entry.path.split("/").slice(0, -1);
    const matched = dirSegments.find((segment) => ignoreSet.has(segment));
    if (matched === undefined) {
      included.push(entry);
      continue;
    }
    const bucket = excluded.get(matched) ?? [];
    bucket.push(entry);
    excluded.set(matched, bucket);
  }

  return { included, excluded };
}
