import { buildGraph, LAYER_LABELS } from "../graph-core";

const ROOT = process.cwd();
const [mode, arg] = process.argv.slice(2);

if (!mode) {
  console.error("Usage: tsx dev_tools/query-graph.ts <summary|full|file <path>|layer <name>>");
  process.exit(1);
}

const { nodes, edges } = buildGraph(ROOT);

if (mode === "summary") {
  const layers: Record<string, number> = {};
  for (const n of nodes) layers[n.layer] = (layers[n.layer] ?? 0) + 1;

  const usedByCount: Record<string, number> = {};
  for (const e of edges) usedByCount[e.target] = (usedByCount[e.target] ?? 0) + 1;

  const mostUsed = Object.entries(usedByCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, count]) => ({ file, usedBy: count }));

  const isolated = nodes
    .filter((n) => !usedByCount[n.id] && !edges.some((e) => e.source === n.id))
    .map((n) => n.id);

  console.log(JSON.stringify({ files: nodes.length, imports: edges.length, layers, mostUsed, isolated }, null, 2));

} else if (mode === "file") {
  if (!arg) { console.error("Usage: query-graph file <relpath>"); process.exit(1); }

  const node = nodes.find((n) => n.id === arg || n.relPath === arg);
  if (!node) { console.error(`File not found: ${arg}`); process.exit(1); }

  const uses = edges
    .filter((e) => e.source === node.id)
    .map((e) => ({ file: e.target, imports: e.importedNames, typeOnly: e.isTypeOnly }));

  const usedBy = edges
    .filter((e) => e.target === node.id)
    .map((e) => ({ file: e.source, imports: e.importedNames, typeOnly: e.isTypeOnly }));

  console.log(JSON.stringify({
    file: node.relPath,
    layer: LAYER_LABELS[node.layer] ?? node.layer,
    description: node.description.join(" "),
    exports: node.exportNames,
    uses,
    usedBy,
  }, null, 2));

} else if (mode === "layer") {
  if (!arg) { console.error("Usage: query-graph layer <name>"); process.exit(1); }

  const layerKey = Object.keys(LAYER_LABELS).find(
    (k) => k === arg || LAYER_LABELS[k].toLowerCase() === arg.toLowerCase()
  );
  if (!layerKey) {
    console.error(`Unknown layer: ${arg}. Valid: ${Object.keys(LAYER_LABELS).join(", ")}`);
    process.exit(1);
  }

  const usedByCount: Record<string, number> = {};
  for (const e of edges) usedByCount[e.target] = (usedByCount[e.target] ?? 0) + 1;

  const files = nodes
    .filter((n) => n.layer === layerKey)
    .map((n) => ({
      file: n.relPath,
      exports: n.exportNames,
      usedBy: usedByCount[n.id] ?? 0,
    }));

  console.log(JSON.stringify({ layer: LAYER_LABELS[layerKey], files }, null, 2));

} else if (mode === "full") {
  console.log(JSON.stringify({ nodes, edges }, null, 2));

} else {
  console.error(`Unknown mode: ${mode}. Valid: summary, full, file, layer`);
  process.exit(1);
}
