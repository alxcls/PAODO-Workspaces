// Per-workspace git versioning — a SNAPSHOT tool, deliberately independent of any git the
// user/agent uses inside the workspace for their own project.
//
// Two invariants enforce that separation:
//   1. Our git metadata lives OUTSIDE the workspace tree, at <root>/.versioning/<workspaceId>,
//      pointed at the workspace via --work-tree. So the workspace never contains our `.git`, and
//      the agent is free to run its own `git init` in there without colliding with us. The git-dir
//      is keyed on the stable workspaceId (not the dir name) so it survives workspace renames.
//   2. We snapshot EVERYTHING with `add --all --force` and core.excludesFile=/dev/null, so a
//      `.gitignore` the user/agent writes is captured as content but never suppresses files from
//      our snapshot.
//
// Known limitation: if the agent creates its own nested repo (<workspace>/proj/.git), our snapshot
// records that subtree as an embedded-repo gitlink rather than its file bytes. Accepted for v1.
import path from "path";
import { mkdir, rm } from "fs/promises";
import { createLogger } from "../logger";
import { WORKSPACES_ROOT } from "../paths";
import { GitClient, type IGitClient } from "./gitClient";
import type { HistoryEntry, IWorkspaceVersioning, VersionStat, VersionFileStat } from "../interfaces";

const log = createLogger("versioning");

// Stable commit identity so we never depend on (or mutate) the host's global git config.
const IDENTITY = ["-c", "user.name=PAODO Agent", "-c", "user.email=agent@paodo.local"];
// Disable global/home excludes; combined with `add --force` this guarantees a full snapshot.
const NO_EXCLUDES = ["-c", "core.excludesFile=/dev/null"];

const MAX_SUBJECT = 72;

function truncateSubject(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT);
}

export interface WorkspaceVersioningOptions {
  /** Root under which the `.versioning/<id>` git-dirs live. Defaults to WORKSPACES_ROOT. */
  rootDir?: string;
}

export class WorkspaceVersioning implements IWorkspaceVersioning {
  private git: IGitClient;
  private rootDir: string;
  // Per-workspace promise chain: serializes index-mutating ops so concurrent runs on one
  // workspace can't race the git index. Mirrors containerManager's start-lock pattern.
  private locks = new Map<string, Promise<unknown>>();

  constructor(git: IGitClient = new GitClient(), opts: WorkspaceVersioningOptions = {}) {
    this.git = git;
    this.rootDir = opts.rootDir ?? WORKSPACES_ROOT;
  }

  private gitDirFor(workspaceId: string): string {
    return path.join(this.rootDir, ".versioning", workspaceId);
  }

  // The --git-dir/--work-tree prefix that every command needs.
  private base(workspaceId: string, workspaceDir: string): string[] {
    return ["--git-dir", this.gitDirFor(workspaceId), "--work-tree", workspaceDir];
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    // Chain onto the tail regardless of how the previous op settled; the stored tail swallows
    // errors so one failure can't poison the chain. The caller still sees fn's real result.
    const tail = prev.then(fn, fn);
    this.locks.set(
      key,
      tail.catch(() => {}).finally(() => {
        if (this.locks.get(key) === stored) this.locks.delete(key);
      }),
    );
    const stored = this.locks.get(key)!;
    return tail;
  }

  // ---- stage everything (ignore the user's ignore rules) ----
  private addAll(workspaceId: string, workspaceDir: string) {
    return this.git.run([...this.base(workspaceId, workspaceDir), ...NO_EXCLUDES, "add", "--all", "--force"]);
  }

  private async headSha(workspaceId: string, workspaceDir: string): Promise<string | null> {
    const r = await this.git.run([...this.base(workspaceId, workspaceDir), "rev-parse", "--verify", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private async isClean(workspaceId: string, workspaceDir: string): Promise<boolean> {
    const r = await this.git.run([...this.base(workspaceId, workspaceDir), "status", "--porcelain"]);
    return r.stdout.trim() === "";
  }

  private async commit(workspaceId: string, workspaceDir: string, message: string, extra: string[] = []): Promise<string> {
    const r = await this.git.run([...this.base(workspaceId, workspaceDir), ...IDENTITY, "commit", "-m", message, ...extra]);
    if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr || r.stdout}`);
    const sha = await this.headSha(workspaceId, workspaceDir);
    if (!sha) throw new Error("git commit succeeded but HEAD is unresolved");
    return sha;
  }

  // ---- public API (each mutating method serialized on workspaceId) ----

  // Idempotent: `git init` is safe to re-run, so we always init then commit only if HEAD is absent.
  private async _initRepo(workspaceId: string, workspaceDir: string): Promise<void> {
    await mkdir(path.dirname(this.gitDirFor(workspaceId)), { recursive: true });
    const init = await this.git.run([...this.base(workspaceId, workspaceDir), "init"]);
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr || init.stdout}`);
    if (await this.headSha(workspaceId, workspaceDir)) return; // already has a root commit
    await this.addAll(workspaceId, workspaceDir);
    // --allow-empty so a freshly-created (or empty) workspace still gets a stable baseline ref.
    await this.commit(workspaceId, workspaceDir, "init", ["--allow-empty"]);
  }

  initRepo(workspaceId: string, workspaceDir: string): Promise<void> {
    return this.serialize(workspaceId, () => this._initRepo(workspaceId, workspaceDir));
  }

  commitBaseline(workspaceId: string, workspaceDir: string, prompt: string): Promise<{ sha: string }> {
    return this.serialize(workspaceId, async () => {
      await this._initRepo(workspaceId, workspaceDir);
      await this.addAll(workspaceId, workspaceDir);
      if (await this.isClean(workspaceId, workspaceDir)) {
        const sha = await this.headSha(workspaceId, workspaceDir);
        return { sha: sha! };
      }
      const sha = await this.commit(workspaceId, workspaceDir, `pre-run: ${truncateSubject(prompt)}`);
      return { sha };
    });
  }

  commitResult(workspaceId: string, workspaceDir: string, summary: string): Promise<{ sha: string; changed: boolean }> {
    return this.serialize(workspaceId, async () => {
      await this._initRepo(workspaceId, workspaceDir);
      await this.addAll(workspaceId, workspaceDir);
      if (await this.isClean(workspaceId, workspaceDir)) {
        const sha = await this.headSha(workspaceId, workspaceDir);
        return { sha: sha!, changed: false };
      }
      // Run number derives from git itself (count of run/* tags) so it survives restarts and
      // stays correct under the per-workspace lock above.
      const tags = await this.git.run([...this.base(workspaceId, workspaceDir), "tag", "--list", "run/*"]);
      const n = tags.stdout.trim() === "" ? 1 : tags.stdout.trim().split("\n").length + 1;
      const sha = await this.commit(workspaceId, workspaceDir, `run ${n}: ${truncateSubject(summary)}`);
      await this.git.run([...this.base(workspaceId, workspaceDir), "tag", `run/${n}`, sha]);
      return { sha, changed: true };
    });
  }

  async history(workspaceId: string, workspaceDir: string): Promise<HistoryEntry[]> {
    const head = await this.headSha(workspaceId, workspaceDir);
    if (!head) return [];
    // --all lists snapshots across every ref, not just those reachable from HEAD. A restore
    // (reset --hard) makes the "future" snapshots unreachable from HEAD, but each one keeps its
    // run/* tag, so --all still surfaces them — letting the user jump forward again. Date-ordered
    // newest-first. %x1f = field separator, %x1e = record separator (robust against newlines).
    const r = await this.git.run(
      [...this.base(workspaceId, workspaceDir), "log", "--all", "--pretty=format:%H%x1f%ct%x1f%s%x1e"],
      { trimStdout: false },
    );
    if (r.code !== 0) return [];
    return r.stdout
      .split("\x1e")
      .map((rec) => rec.replace(/^\n/, ""))
      .filter((rec) => rec.trim() !== "")
      .map((rec) => {
        const [sha, ct, subject] = rec.split("\x1f");
        return {
          sha,
          message: subject ?? "",
          timestamp: new Date(Number(ct) * 1000).toISOString(),
          current: sha === head,
        };
      });
  }

  async diff(workspaceId: string, workspaceDir: string, from: string, to: string): Promise<string> {
    const r = await this.git.run(
      [...this.base(workspaceId, workspaceDir), "diff", from, to],
      { trimStdout: false },
    );
    return r.stdout;
  }

  // Last `n` snapshots (across all refs, like history()) with each commit's per-file numstat vs
  // its parent. Read-only, so no serialize() lock. The %x1e record separator prefixes every
  // commit's pretty line; --numstat rows follow on subsequent lines. Binary files show "-" for
  // add/del in numstat — we surface them as -1 so the formatter can mark them rather than lie.
  async versionStats(workspaceId: string, workspaceDir: string, n: number): Promise<VersionStat[]> {
    const count = Math.max(1, Math.min(20, Math.floor(n) || 1));
    const head = await this.headSha(workspaceId, workspaceDir);
    if (!head) return [];
    const r = await this.git.run(
      [
        ...this.base(workspaceId, workspaceDir),
        "log", "--all", `-n${count}`, "--no-renames", "--numstat",
        "--pretty=format:%x1e%h%x1f%cr%x1f%s",
      ],
      { trimStdout: false },
    );
    if (r.code !== 0) return [];
    return r.stdout
      .split("\x1e")
      .filter((rec) => rec.trim() !== "")
      .map((rec) => {
        const lines = rec.replace(/^\n/, "").split("\n");
        const [sha, age, subject] = lines[0].split("\x1f");
        const files: VersionFileStat[] = [];
        let totalAdd = 0;
        let totalDel = 0;
        for (const line of lines.slice(1)) {
          const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
          if (!m) continue;
          const add = m[1] === "-" ? -1 : Number(m[1]);
          const del = m[2] === "-" ? -1 : Number(m[2]);
          files.push({ path: m[3], add, del });
          if (add > 0) totalAdd += add;
          if (del > 0) totalDel += del;
        }
        // head is the full %H; the log emits abbreviated %h, so prefix-match to flag the snapshot
        // the work-tree is currently on (this is what a UI restore's reset --hard moves).
        const current = head.startsWith(sha);
        return { sha, age: age ?? "", subject: subject ?? "", files, totalAdd, totalDel, current };
      });
  }

  // Raw diff for a single snapshot (`git show sha`), or the cumulative diff across snapshots
  // (`git diff from sha`) when opts.from is given — so the agent can see what changed between two
  // arbitrary versions, not just one step. The tool layer strips boilerplate and pages length;
  // here we just emit git's native output (optionally word-diff / path-scoped). Read-only.
  async versionDiff(
    workspaceId: string,
    workspaceDir: string,
    sha: string,
    opts: { path?: string; wordDiff?: boolean; from?: string } = {},
  ): Promise<string> {
    const args = [...this.base(workspaceId, workspaceDir)];
    // from → range diff (from..sha); otherwise the snapshot's own diff vs its parent.
    args.push(opts.from ? "diff" : "show", "--no-renames");
    if (opts.wordDiff) args.push("--word-diff=plain");
    if (opts.from) args.push(opts.from, sha);
    else args.push(sha);
    if (opts.path) args.push("--", opts.path);
    const r = await this.git.run(args, { trimStdout: false });
    return r.stdout;
  }

  // Destroy the workspace's entire version history. Called on workspace deletion so versioning
  // data never outlives the workspace it belongs to. Serialized so it can't race an in-flight
  // commit (serialize() clears the lock entry afterwards).
  deleteRepo(workspaceId: string): Promise<void> {
    return this.serialize(workspaceId, () => rm(this.gitDirFor(workspaceId), { recursive: true, force: true }));
  }

  restore(workspaceId: string, workspaceDir: string, sha: string): Promise<boolean> {
    return this.serialize(workspaceId, async () => {
      const verify = await this.git.run([...this.base(workspaceId, workspaceDir), "rev-parse", "--verify", `${sha}^{commit}`]);
      if (verify.code !== 0) {
        log.warn({ workspaceId, sha }, "restore: unknown sha");
        return false;
      }
      const reset = await this.git.run([...this.base(workspaceId, workspaceDir), "reset", "--hard", sha]);
      if (reset.code !== 0) log.error({ workspaceId, sha, stderr: reset.stderr }, "restore: reset failed");
      return reset.code === 0;
    });
  }
}
