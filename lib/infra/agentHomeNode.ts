// Brings agent homes seeded by an older workspace image onto its current Node. The app never opens a
// file inside a home (the agent can plant symlinks there): both scripts run confined to that home.
import { readFile } from "fs/promises";

// Defaults the image set before homes recorded a `.node` marker: `nvm alias default 22` (2026-08-25),
// then the exact pin (2026-08-26). Durable homes did not exist before that.
const LEGACY_IMAGE_DEFAULTS = ["22", "22.23.2"];
// nvm installs these with every Node version; any other global package was added by the agent.
const BUNDLED_GLOBALS = new Set(["npm", "corepack"]);
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** Reports what the home holds, one fact per line. SEED is overridable only so tests can run it. */
export const INSPECT_HOME_SCRIPT = `
H=\${SEED:-/seed}/.nvm
[ -s "$H/nvm.sh" ] && echo nvm
[ -f "$H/alias/default" ] && printf 'alias %s\\n' "$(head -n 1 "$H/alias/default")"
for d in "$H"/versions/node/v*; do
  [ -d "$d" ] || continue
  v=\${d##*/v}
  if [ -x "$d/bin/node" ]; then echo "version $v"; else echo "broken $v"; fi
  for m in "$d"/lib/node_modules/* "$d"/lib/node_modules/@*/*; do
    [ -e "$m" ] || continue
    n=\${m#"$d"/lib/node_modules/}
    case $n in @*/*) ;; @*) continue ;; esac
    echo "global $v $n"
  done
done
exit 0
`;

/**
 * $1 version, $2 copy it from the image (1/0), $3 make it nvm's default (1/0). Each step is staged
 * and renamed into place, so a concurrent shell never sees a half-copied Node or half-written alias.
 */
export const APPLY_NODE_SCRIPT = `
set -eu
V=$1
N=\${SEED:-/seed}/.nvm/versions/node
if [ "$2" = 1 ]; then
  mkdir -p "$N"
  rm -rf "$N/.v$V.tmp"
  cp -a "\${SRC:-/home/dev/.nvm/versions/node}/v$V" "$N/.v$V.tmp"
  rm -rf "$N/v$V"
  mv "$N/.v$V.tmp" "$N/v$V"
fi
if [ "$3" = 1 ]; then
  A=\${SEED:-/seed}/.nvm/alias
  mkdir -p "$A"
  printf '%s\\n' "$V" > "$A/.default.tmp"
  mv -f "$A/.default.tmp" "$A/default"
fi
`;

export interface HomeFacts {
  nvm: boolean;
  alias: string | null;
  /** Versions whose `bin/node` is executable; a half-present one counts as absent. */
  installed: string[];
  globals: Record<string, string[]>;
}

export type NodeUpgradePlan =
  | { action: "skip"; reason: "no_nvm" }
  | {
      action: "deliver";
      copy: boolean;
      previous: string | null;
      default: "move" | "current" | "custom" | "global_packages";
      globals: string[];
    };

async function readTrimmed(p: string): Promise<string | null> {
  try {
    return (await readFile(p, "utf-8")).trim();
  } catch {
    return null;
  }
}

/** The exact Node version Dockerfile.workspace installs, or null when it can't be read. */
export async function imageNodeVersion(dockerfilePath: string): Promise<string | null> {
  const content = await readTrimmed(dockerfilePath);
  return content?.match(/^ARG NODE_VERSION=(\d+\.\d+\.\d+)$/m)?.[1] ?? null;
}

/** The version recorded in the `.node` marker — a sibling of the home, never agent-writable. */
export const readNodeMarker = (markerPath: string): Promise<string | null> => readTrimmed(markerPath);

// The output is agent-influenced (file names), so anything unexpected is dropped rather than trusted;
// at worst an agent misleads the decision about its own home, which the confined apply step bounds.
export function parseHomeFacts(stdout: string): HomeFacts {
  const facts: HomeFacts = { nvm: false, alias: null, installed: [], globals: {} };
  for (const line of stdout.split("\n")) {
    const [kind, first, ...rest] = line.split(" ");
    if (kind === "nvm" && first === undefined) facts.nvm = true;
    else if (kind === "alias" && first) facts.alias = [first, ...rest].join(" ").trim();
    else if (kind === "version" && EXACT_VERSION.test(first ?? "")) facts.installed.push(first);
    else if (kind === "global" && EXACT_VERSION.test(first ?? "") && rest.length) {
      (facts.globals[first] ??= []).push(rest.join(" "));
    }
  }
  return facts;
}

const byVersion = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
};

/** The installed version an nvm alias resolves to, the way nvm does for exact and major-only aliases. */
function resolveAlias(alias: string, installed: string[]): string | null {
  const wanted = alias.replace(/^v/, "");
  if (EXACT_VERSION.test(wanted)) return installed.includes(wanted) ? wanted : null;
  if (!/^\d+$/.test(wanted)) return null;
  return (
    installed
      .filter((v) => v.split(".")[0] === wanted)
      .sort(byVersion)
      .pop() ?? null
  );
}

/**
 * Decide what bringing this home onto `target` involves. `marker` is the version the image last
 * delivered here. The default only moves while it still names what the image itself chose, and while
 * that Node carries no global packages the agent installed.
 */
export function planNodeUpgrade(facts: HomeFacts, marker: string | null, target: string): NodeUpgradePlan {
  if (!facts.nvm) return { action: "skip", reason: "no_nvm" };
  const copy = !facts.installed.includes(target);
  const imageDefaults = marker ? [marker] : LEGACY_IMAGE_DEFAULTS;
  const previous = facts.alias ? resolveAlias(facts.alias, facts.installed) : null;

  if (previous === target) return { action: "deliver", copy, previous, default: "current", globals: [] };
  if (facts.alias && !imageDefaults.includes(facts.alias.replace(/^v/, ""))) {
    return { action: "deliver", copy, previous, default: "custom", globals: [] };
  }
  const globals = previous ? (facts.globals[previous] ?? []).filter((n) => !BUNDLED_GLOBALS.has(n)).sort() : [];
  return { action: "deliver", copy, previous, default: globals.length ? "global_packages" : "move", globals };
}
