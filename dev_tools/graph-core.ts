import { Project, SourceFile } from "ts-morph";
import * as path from "path";

export interface GraphNode {
  id: string;
  label: string;
  layer: string;
  exportNames: string[];
  description: string[];
  relPath: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  importedNames: string[];
  isTypeOnly: boolean;
}

export const LAYER_COLORS: Record<string, { bg: string; border: string; fg: string }> = {
  entry:      { bg: "#e74c3c", border: "#c0392b", fg: "#fca5a5" },
  infra:      { bg: "#e67e22", border: "#d35400", fg: "#fdba74" },
  agent:      { bg: "#9b59b6", border: "#8e44ad", fg: "#d8b4fe" },
  tools:      { bg: "#7c3aed", border: "#6d28d9", fg: "#c4b5fd" },
  api:        { bg: "#16a34a", border: "#15803d", fg: "#86efac" },
  pages:      { bg: "#2563eb", border: "#1d4ed8", fg: "#93c5fd" },
  components: { bg: "#0891b2", border: "#0e7490", fg: "#67e8f9" },
  types:      { bg: "#64748b", border: "#475569", fg: "#cbd5e1" },
  other:      { bg: "#6b7280", border: "#4b5563", fg: "#d1d5db" },
};

export const LAYER_LABELS: Record<string, string> = {
  entry:      "Entry",
  infra:      "Infra",
  agent:      "Agent",
  tools:      "Tools",
  api:        "API Routes",
  pages:      "Pages",
  components: "Components",
  types:      "Types",
  other:      "Other",
};

export function getLayer(relPath: string): string {
  if (relPath === "server.ts") return "entry";
  if (relPath.startsWith("lib/infra/")) return "infra";
  if (relPath.startsWith("lib/agent/tools/")) return "tools";
  if (relPath.startsWith("lib/agent/")) return "agent";
  if (relPath.startsWith("app/api/")) return "api";
  if (relPath.startsWith("components/")) return "components";
  if (relPath.startsWith("app/")) return "pages";
  if (relPath.startsWith("types/")) return "types";
  return "other";
}

export function getLabel(relPath: string): string {
  const parts = relPath.split("/");
  if (parts.length <= 2) return relPath;
  return parts.slice(-2).join("/");
}

export function getLeadingComments(sf: SourceFile): string[] {
  const lines = sf.getFullText().split("\n");
  const comments: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) {
      comments.push(trimmed.slice(2).trim());
    } else {
      break;
    }
  }
  return comments;
}

export function buildGraph(root: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const project = new Project({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    skipAddingFilesFromTsConfig: false,
  });

  const sourceFiles = project.getSourceFiles().filter((sf) => {
    const absPath = sf.getFilePath();
    return (
      !absPath.includes("node_modules") &&
      !absPath.includes("/.next/") &&
      !absPath.endsWith(".d.ts") &&
      absPath.startsWith(root + "/")
    );
  });

  const nodes: GraphNode[] = [];
  const nodeIdSet = new Set<string>();
  const edgeMap = new Map<string, GraphEdge>();
  let edgeIndex = 0;

  for (const sf of sourceFiles) {
    const relPath = path.relative(root, sf.getFilePath());
    const exportNames: string[] = [];
    for (const [name] of sf.getExportedDeclarations()) exportNames.push(name);
    nodes.push({
      id: relPath,
      label: getLabel(relPath),
      layer: getLayer(relPath),
      exportNames,
      description: getLeadingComments(sf),
      relPath,
    });
    nodeIdSet.add(relPath);
  }

  for (const sf of sourceFiles) {
    const sourceId = path.relative(root, sf.getFilePath());
    for (const importDecl of sf.getImportDeclarations()) {
      const resolvedFile = importDecl.getModuleSpecifierSourceFile();
      if (!resolvedFile) continue;
      const targetAbsPath = resolvedFile.getFilePath();
      if (targetAbsPath.includes("node_modules")) continue;
      if (!targetAbsPath.startsWith(root + "/")) continue;
      const targetId = path.relative(root, targetAbsPath);
      if (!nodeIdSet.has(targetId)) continue;
      if (sourceId === targetId) continue;

      const isTypeOnly = importDecl.isTypeOnly();
      const names = importDecl.getNamedImports().map((ni) => ni.getName());
      const key = `${sourceId}→${targetId}`;

      if (edgeMap.has(key)) {
        const existing = edgeMap.get(key)!;
        for (const n of names) {
          if (!existing.importedNames.includes(n)) existing.importedNames.push(n);
        }
        if (!isTypeOnly) existing.isTypeOnly = false;
      } else {
        edgeMap.set(key, {
          id: `e${edgeIndex++}`,
          source: sourceId,
          target: targetId,
          importedNames: [...names],
          isTypeOnly,
        });
      }
    }
  }

  return { nodes, edges: Array.from(edgeMap.values()) };
}
