// Returns the workspace file tree as a nested JSON structure for the file tree panel.
//
// The effective ignore contract ships alongside it. The browser imports lib/files/ignore directly, but
// a non-bundled client (the CLI) cannot, and the one thing it must not do is hardcode a second copy of
// the list — see the reasoning in that module. Serving it from the tree route means the client that
// asks "what is in this workspace" gets "and here is what never travels" in the same answer.
import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { buildTree } from "@/lib/files/tree";
import { IGNORE_CONTRACT } from "@/lib/files/ignore";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  // The default depth is the file panel's, which is a rendering budget rather than a fact about the
  // workspace. A client that lists to act on the result rather than to draw it asks for the whole tree
  // instead of being handed a truncation it cannot see.
  const full = new URL(req.url).searchParams.get("depth") === "full";
  const tree = await buildTree(ws.dir, full ? { maxDepth: Infinity } : {});
  return NextResponse.json({ tree, ignore: IGNORE_CONTRACT, truncated: !full });
}
