import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTreeResource, type TreeNode } from "./fileTreeResource";

const dir = (path: string): TreeNode => ({ name: path.split("/").pop()!, path, type: "directory" });
const file = (path: string): TreeNode => ({ name: path.split("/").pop()!, path, type: "file" });
const response = (tree: TreeNode[], status = 200) => new Response(JSON.stringify({ tree }), { status });
const resource = () => new FileTreeResource("/api/workspaces/test");

function serve(levels: Record<string, TreeNode[]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => response(levels[new URL(url, "http://test").searchParams.get("path") ?? ""] ?? [])),
  );
}

function deferReads() {
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, { signal }: { signal: AbortSignal }) =>
        new Promise<Response>((resolve) => {
          requests.push({ signal, resolve });
        }),
    ),
  );
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("FileTreeResource", () => {
  it("refreshes root and nested loaded folders without discarding their children", async () => {
    const levels = { "": [dir("src")], src: [dir("src/lib")], "src/lib": [file("src/lib/old.ts")] };
    serve(levels);
    const tree = resource();
    await tree.refresh();
    await tree.loadChildren("src");
    await tree.loadChildren("src/lib");
    levels["src/lib"] = [file("src/lib/new.ts")];
    await tree.refresh();
    expect(tree.getSnapshot().tree[0].children?.[0].children).toEqual(levels["src/lib"]);
    expect(tree.getSnapshot().initialLoading).toBe(false);
  });

  it("keeps loaded content visible while root and child refreshes are pending", async () => {
    serve({ "": [dir("src")], src: [file("src/a.ts")] });
    const tree = resource();
    await tree.refresh();
    await tree.loadChildren("src");
    const reads = deferReads();
    const pending = tree.refresh();
    expect(tree.getSnapshot().initialLoading).toBe(false);
    expect(tree.getSnapshot().loadingDirs.size).toBe(0);
    expect(tree.getSnapshot().tree[0].children).toEqual([file("src/a.ts")]);
    reads[0].resolve(response([dir("src")]));
    reads[1].resolve(response([file("src/b.ts")]));
    await pending;
    expect(tree.getSnapshot().tree[0].children).toEqual([file("src/b.ts")]);
  });

  it("ignores an older root refresh even if the transport completes after cancellation", async () => {
    const reads = deferReads();
    const tree = resource();
    const first = tree.refresh();
    const second = tree.refresh();
    expect(reads[0].signal.aborted).toBe(true);
    reads[1].resolve(response([file("new.ts")]));
    await second;
    reads[0].resolve(response([file("old.ts")]));
    await first;
    expect(tree.getSnapshot().tree).toEqual([file("new.ts")]);
  });

  it("supersedes an in-flight expansion when a refresh begins", async () => {
    serve({ "": [dir("src")] });
    const tree = resource();
    await tree.refresh();
    const reads = deferReads();
    const expansion = tree.loadChildren("src");
    const refresh = tree.refresh();
    expect(reads[0].signal.aborted).toBe(true);
    reads[1].resolve(response([dir("src")]));
    reads[2].resolve(response([file("src/new.ts")]));
    await refresh;
    reads[0].resolve(response([file("src/old.ts")]));
    await expansion;
    expect(tree.getSnapshot().tree[0].children).toEqual([file("src/new.ts")]);
  });

  it("shows initial retry loading, and recovers after a failed root read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([], 500)),
    );
    const tree = resource();
    await tree.refresh();
    expect(tree.getSnapshot().initialError).toBe(true);
    const reads = deferReads();
    const retry = tree.refresh();
    expect(tree.getSnapshot().initialLoading).toBe(true);
    expect(tree.getSnapshot().initialError).toBe(false);
    reads[0].resolve(response([file("ok.ts")]));
    await retry;
    expect(tree.getSnapshot().tree).toEqual([file("ok.ts")]);
  });

  it("retains the tree on a background failure and exposes a refresh error", async () => {
    serve({ "": [file("keep.ts")] });
    const tree = resource();
    await tree.refresh();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([], 500)),
    );
    await tree.refresh();
    expect(tree.getSnapshot().tree).toEqual([file("keep.ts")]);
    expect(tree.getSnapshot().refreshError).toBe(true);
    expect(tree.getSnapshot().initialError).toBe(false);
  });

  it("does not automatically loop on directory failures, but permits an explicit retry", async () => {
    serve({ "": [dir("src")] });
    const tree = resource();
    await tree.refresh();
    const fetchMock = vi.fn(async () => response([], 500));
    vi.stubGlobal("fetch", fetchMock);
    await tree.loadChildren("src", true);
    await tree.loadChildren("src", true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tree.getSnapshot().dirErrors.has("src")).toBe(true);
    serve({ src: [file("src/recovered.ts")] });
    await tree.loadChildren("src");
    expect(tree.getSnapshot().dirErrors.size).toBe(0);
    expect(tree.getSnapshot().tree[0].children).toEqual([file("src/recovered.ts")]);
  });

  it("invalidates removed folders so recreating their path cannot reuse stale children", async () => {
    const levels: Record<string, TreeNode[]> = { "": [dir("src")], src: [file("src/old.ts")] };
    serve(levels);
    const tree = resource();
    await tree.refresh();
    await tree.loadChildren("src");
    levels[""] = [];
    await tree.refresh();
    levels[""] = [dir("src")];
    levels.src = [file("src/new.ts")];
    await tree.refresh();
    expect(tree.getSnapshot().tree[0].children).toBeUndefined();
    await tree.loadChildren("src");
    expect(tree.getSnapshot().tree[0].children).toEqual(levels.src);
  });

  it("absorbs a deep read so nested folders render and re-expand without refetching", async () => {
    const nested: TreeNode[] = [{ ...dir("src"), children: [{ ...dir("src/lib"), children: [file("src/lib/a.ts")] }] }];
    const fetchMock = vi.fn(async () => response(nested));
    vi.stubGlobal("fetch", fetchMock);
    const tree = resource();
    await tree.refresh();
    expect(tree.getSnapshot().tree[0].children?.[0].children).toEqual([file("src/lib/a.ts")]);
    await tree.loadChildren("src");
    await tree.loadChildren("src/lib");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes only fetched roots, not the levels absorbed from a deep read", async () => {
    const nested: TreeNode[] = [{ ...dir("src"), children: [file("src/a.ts")] }];
    const fetchMock = vi.fn(async () => response(nested));
    vi.stubGlobal("fetch", fetchMock);
    const tree = resource();
    await tree.refresh();
    await tree.loadChildren("src");
    fetchMock.mockClear();
    await tree.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels detached views and ignores their late responses", async () => {
    const reads = deferReads();
    const tree = resource();
    const pending = tree.refresh();
    tree.cancel();
    expect(reads[0].signal.aborted).toBe(true);
    reads[0].resolve(response([file("late.ts")]));
    await pending;
    expect(tree.getSnapshot().tree).toEqual([]);
  });
});
