export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

export interface FileTreeSnapshot {
  tree: TreeNode[];
  initialLoading: boolean;
  initialError: boolean;
  refreshError: boolean;
  loadingDirs: Set<string>;
  dirErrors: Set<string>;
}

/** Levels fetched per request, mirroring the panel's old single-shot budget so expanding within the
 *  loaded depth is instant; deeper folders still fetch lazily. */
const TREE_FETCH_DEPTH = 5;

/** One cache per file API. Root refreshes reattach cached descendants instead of losing them. */
export class FileTreeResource {
  private levels = new Map<string, TreeNode[]>();
  private requests = new Map<string, AbortController>();
  private errors = new Set<string>();
  /** Paths actually fetched, as opposed to levels absorbed from a parent's deep read — the set a
   *  refresh re-reads, since a deep read already re-covers everything beneath it. */
  private roots = new Set<string>();
  private listeners = new Set<() => void>();
  private snapshot: FileTreeSnapshot = {
    tree: [],
    initialLoading: true,
    initialError: false,
    refreshError: false,
    loadingDirs: new Set(),
    dirErrors: new Set(),
  };

  constructor(private base: string) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private build(path = ""): TreeNode[] {
    return (this.levels.get(path) ?? []).map((node) =>
      node.type === "directory" && this.levels.has(node.path) ? { ...node, children: this.build(node.path) } : node,
    );
  }

  private publish() {
    const loaded = this.levels.has("");
    this.snapshot = {
      tree: this.build(),
      initialLoading: !loaded && !this.errors.has(""),
      initialError: !loaded && this.errors.has(""),
      refreshError: loaded && this.errors.has(""),
      // Already visible children stay on screen during a background refresh.
      loadingDirs: new Set([...this.requests.keys()].filter((path) => path !== "" && !this.levels.has(path))),
      dirErrors: new Set([...this.errors].filter((path) => path !== "")),
    };
    this.listeners.forEach((listener) => listener());
  }

  /** Cache a deep read: the fetched root, then every directory it listed above the depth cut, so those
   *  render and re-expand without a second request. A directory at the cut has empty children we cannot
   *  tell from a truly empty one, so it is left unregistered to fetch on expand. */
  private absorb(root: string, tree: TreeNode[], maxDepth: number) {
    this.levels.set(root, tree);
    const register = (nodes: TreeNode[], depth: number) => {
      if (depth >= maxDepth) return;
      for (const node of nodes) {
        if (node.type !== "directory" || !node.children) continue;
        this.levels.set(node.path, node.children);
        register(node.children, depth + 1);
      }
    };
    register(tree, 1);
  }

  private prune() {
    if (!this.levels.has("")) return;
    const reachable = new Set([""]);
    const visit = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type !== "directory") continue;
        reachable.add(node.path);
        if (node.children) visit(node.children);
      }
    };
    visit(this.build());
    for (const path of new Set([...this.levels.keys(), ...this.requests.keys(), ...this.errors, ...this.roots])) {
      if (reachable.has(path)) continue;
      this.levels.delete(path);
      this.errors.delete(path);
      this.roots.delete(path);
      this.requests.get(path)?.abort();
      this.requests.delete(path);
    }
  }

  private async read(path: string) {
    this.requests.get(path)?.abort();
    const controller = new AbortController();
    this.requests.set(path, controller);
    this.roots.add(path);
    this.errors.delete(path);
    this.publish();
    try {
      const depth = `depth=${TREE_FETCH_DEPTH}`;
      const query = path === "" ? `?${depth}` : `?path=${encodeURIComponent(path)}&${depth}`;
      const response = await fetch(`${this.base}/files${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Could not load files");
      const { tree } = (await response.json()) as { tree: TreeNode[] };
      if (controller.signal.aborted) return;
      this.absorb(path, tree, TREE_FETCH_DEPTH);
      this.prune();
    } catch {
      if (!controller.signal.aborted) this.errors.add(path);
    } finally {
      if (this.requests.get(path) === controller) {
        this.requests.delete(path);
        this.publish();
      }
    }
  }

  loadChildren = async (path: string, auto = false) => {
    // Expanded UI state may still name a removed folder, or one from the previous workspace.
    const exists = (nodes: TreeNode[]): boolean =>
      nodes.some(
        (node) =>
          node.type === "directory" && (node.path === path || (node.children !== undefined && exists(node.children))),
      );
    if (!exists(this.snapshot.tree)) return;
    if (this.requests.has(path)) return;
    if (auto && this.errors.has(path)) return;
    if (this.levels.has(path) && !this.errors.has(path)) return;
    await this.read(path);
  };

  refresh = async () => {
    // Re-read only the fetched roots (a deep read re-covers its descendants), plus any expansion still
    // in flight so an older directory read cannot undo a refresh.
    const paths = new Set(["", ...this.roots, ...this.requests.keys(), ...this.errors]);
    await Promise.all([...paths].map((path) => this.read(path)));
  };

  cancel = () => {
    this.requests.forEach((controller) => controller.abort());
    this.requests.clear();
  };
}
