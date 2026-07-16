import * as path from "path";
import * as fs from "fs";
import { buildGraph, LAYER_COLORS, LAYER_LABELS, GraphNode, GraphEdge } from "../graph-core";

const ROOT = process.cwd();

async function main() {
  console.log("Loading TypeScript project...");
  const { nodes, edges } = buildGraph(ROOT);
  console.log(`Graph: ${nodes.length} nodes, ${edges.length} edges`);

  const html = generateHTML(nodes, edges);
  const outputPath = path.join(ROOT, "dev_tools", "viz", "graph.html");
  fs.writeFileSync(outputPath, html, "utf-8");
  console.log(`Written: ${outputPath}`);
}

function generateHTML(nodes: GraphNode[], edges: GraphEdge[]): string {
  const graphDataJSON = JSON.stringify({ nodes, edges });
  const layerColorsJSON = JSON.stringify(LAYER_COLORS);
  const layerLabelsJSON = JSON.stringify(LAYER_LABELS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PAODO_WS &mdash; Codebase Graph</title>
  <script src="https://unpkg.com/cytoscape@3.29.2/dist/cytoscape.min.js"></script>
  <script src="https://unpkg.com/layout-base@2/layout-base.js"></script>
  <script src="https://unpkg.com/cose-base@2/cose-base.js"></script>
  <script src="https://unpkg.com/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #020617;
      color: #e2e8f0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: #0f172a;
      padding: 9px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid #1e293b;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    header h1 { font-size: 13px; font-weight: 700; color: #f1f5f9; white-space: nowrap; }

    .icon-btn {
      padding: 3px 9px; border-radius: 5px; border: 1px solid #1e293b;
      background: transparent; color: #64748b; cursor: pointer; font-size: 10px;
      white-space: nowrap; transition: color 0.15s, border-color 0.15s;
    }
    .icon-btn:hover { color: #e2e8f0; border-color: #334155; }
    .stats { font-size: 10px; color: #334155; margin-left: auto; white-space: nowrap; }

    .main { display: flex; flex: 1; overflow: hidden; }
    #cy { flex: 1; background: #020617; }

    #sidebar {
      width: 280px; background: #0f172a; border-left: 1px solid #1e293b;
      display: flex; flex-direction: column; overflow: hidden; flex-shrink: 0;
    }
    #sidebar-header {
      padding: 9px 13px; border-bottom: 1px solid #1e293b; font-size: 10px;
      font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
      color: #334155; flex-shrink: 0;
    }
    #sidebar-body {
      flex: 1; overflow-y: auto; padding: 12px 13px;
      display: flex; flex-direction: column; gap: 13px;
    }

    #empty-state { color: #334155; font-size: 12px; padding: 4px 0; }

    .detail-title { font-size: 13px; font-weight: 700; word-break: break-all; line-height: 1.4; }
    .detail-path  { font-size: 10px; color: #475569; word-break: break-all; margin-top: 2px; font-family: monospace; }
    .layer-badge  {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 10px; font-weight: 700; color: #fff; margin-top: 5px;
    }
    .section-title {
      font-size: 9px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1px; color: #334155; margin-bottom: 5px;
    }
    .description-block {
      font-size: 11px; line-height: 1.65; color: #94a3b8; background: #020617;
      border-left: 2px solid #1e293b; padding: 7px 10px; border-radius: 0 4px 4px 0;
    }
    .description-block p { margin: 0; }

    .export-list { list-style: none; display: flex; flex-direction: column; gap: 3px; }
    .export-list li {
      font-size: 10px; padding: 3px 7px; background: #020617;
      border-radius: 4px; font-family: monospace; color: #a5f3fc;
    }
    .edge-list { display: flex; flex-direction: column; gap: 4px; }
    .edge-item {
      font-size: 10px; padding: 5px 8px; background: #020617;
      border-radius: 4px; border-left: 2px solid #1e293b;
    }
    .edge-file  { color: #cbd5e1; word-break: break-all; }
    .edge-names { color: #60a5fa; font-family: monospace; font-size: 9px; margin-top: 2px; }
    .edge-type  { color: #a78bfa; font-style: italic; }

    #tooltip {
      position: fixed; background: #0f172a; border: 1px solid #1e293b;
      border-radius: 5px; padding: 5px 9px; font-size: 10px; color: #e2e8f0;
      pointer-events: none; display: none; z-index: 999; max-width: 260px;
      font-family: monospace; white-space: pre-wrap;
    }
  </style>
</head>
<body>
<header>
  <h1>PAODO_WS &mdash; Codebase Graph</h1>
  <button class="icon-btn" id="resetBtn">Reset view</button>
  <button class="icon-btn" id="resetLayoutBtn">Reset layout</button>
  <span class="stats" id="stats"></span>
</header>

<div class="main">
  <div id="cy"></div>
  <div id="sidebar">
    <div id="sidebar-header">Node details</div>
    <div id="sidebar-body">
      <div id="empty-state">Click a node to inspect it</div>
      <div id="node-detail" style="display:none"></div>
    </div>
  </div>
</div>

<div id="tooltip"></div>

<script>
var GRAPH_DATA   = ${graphDataJSON};
var LAYER_COLORS = ${layerColorsJSON};
var LAYER_LABELS = ${layerLabelsJSON};

var elements = [];

for (var i = 0; i < GRAPH_DATA.nodes.length; i++) {
  var n = GRAPH_DATA.nodes[i];
  var c = LAYER_COLORS[n.layer] || LAYER_COLORS.other;
  elements.push({
    data: {
      id: n.id, label: n.label, layer: n.layer,
      exportNames: n.exportNames, description: n.description, relPath: n.relPath,
      bg: c.bg, border: c.border, fg: c.fg
    }
  });
}

for (var j = 0; j < GRAPH_DATA.edges.length; j++) {
  var e = GRAPH_DATA.edges[j];
  elements.push({
    data: {
      id: e.id, source: e.source, target: e.target,
      importedNames: e.importedNames, isTypeOnly: e.isTypeOnly
    }
  });
}

var POSITIONS_KEY = "PAODO_WS:graph:positions";

var FCOSE_LAYOUT = {
  name: "fcose",
  quality: "default",
  randomize: false,
  animate: false,
  nodeDimensionsIncludeLabels: true,
  packComponents: true,
  nodeRepulsion: 6000,
  idealEdgeLength: 100,
  edgeElasticity: 0.4,
  gravity: 0.2,
  numIter: 2500,
  tile: true,
  tilingPaddingVertical: 20,
  tilingPaddingHorizontal: 20
};

function savePositions() {
  var pos = {};
  cy.nodes().forEach(function(n) { pos[n.id()] = n.position(); });
  try { localStorage.setItem(POSITIONS_KEY, JSON.stringify(pos)); } catch(e) {}
}

function loadPositions() {
  try { return JSON.parse(localStorage.getItem(POSITIONS_KEY) || "null"); } catch(e) { return null; }
}

var savedPositions = loadPositions();
var allCovered = savedPositions && GRAPH_DATA.nodes.every(function(n) { return savedPositions[n.id]; });
var initialLayout = allCovered
  ? { name: "preset", positions: function(n) { return savedPositions[n.id()]; }, fit: true, padding: 40 }
  : FCOSE_LAYOUT;

var cy = cytoscape({
  container: document.getElementById("cy"),
  elements: elements,
  style: [
    {
      selector: "node",
      style: {
        "background-color": "data(bg)",
        "border-color": "data(border)",
        "border-width": 2,
        "label": "data(label)",
        "color": "#fff",
        "font-size": 10,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": 130,
        "padding": 10,
        "shape": "roundrectangle",
        "width": "label",
        "height": "label",
        "min-zoomed-font-size": 7
      }
    },
    {
      selector: "node.dimmed",
      style: { "opacity": 0.1 }
    },
    {
      selector: "node.highlighted",
      style: { "border-width": 3, "border-color": "#f1f5f9" }
    },
    {
      selector: "edge",
      style: {
        "width": 1.5,
        "line-color": "#1e3a5f",
        "target-arrow-color": "#1e3a5f",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "opacity": 0.75
      }
    },
    {
      selector: "edge[?isTypeOnly]",
      style: {
        "line-style": "dashed",
        "line-color": "#312e81",
        "target-arrow-color": "#312e81",
        "opacity": 0.4
      }
    },
    {
      selector: "edge.highlighted",
      style: {
        "line-color": "#3b82f6",
        "target-arrow-color": "#3b82f6",
        "opacity": 1,
        "width": 2.5
      }
    },
    {
      selector: "edge.dimmed",
      style: { "opacity": 0.03 }
    }
  ],
  layout: initialLayout
});

savePositions();
cy.on("dragfree", "node", savePositions);

document.getElementById("stats").textContent =
  GRAPH_DATA.nodes.length + " files  ·  " + GRAPH_DATA.edges.length + " imports";

// --- Reset view ---
document.getElementById("resetBtn").addEventListener("click", function() {
  cy.nodes().removeClass("highlighted dimmed").style("opacity", 1);
  cy.edges().removeClass("highlighted dimmed").style("opacity", 0.75);
  cy.fit(undefined, 40);
  showEmpty();
});

// --- Reset layout ---
document.getElementById("resetLayoutBtn").addEventListener("click", function() {
  try { localStorage.removeItem(POSITIONS_KEY); } catch(e) {}
  cy.layout(FCOSE_LAYOUT).run();
  savePositions();
});

// --- Node click ---
cy.on("tap", "node", function(evt) {
  var node = evt.target;
  cy.nodes().style("opacity", 1).removeClass("highlighted dimmed");
  cy.edges().style("opacity", 0.75).removeClass("highlighted dimmed");

  var neighborhood = node.neighborhood();
  cy.elements().not(neighborhood).not(node).nodes().addClass("dimmed");
  cy.elements().not(neighborhood).not(node).edges().addClass("dimmed");
  neighborhood.edges().addClass("highlighted");
  node.addClass("highlighted");

  showDetail(node);
});

cy.on("tap", function(evt) {
  if (evt.target === cy) { clearHighlight(); showEmpty(); }
});

// --- Edge tooltip ---
var tooltip = document.getElementById("tooltip");
cy.on("mouseover", "edge", function(evt) {
  var e = evt.target;
  var names = e.data("importedNames") || [];
  if (names.length === 0) return;
  tooltip.textContent = names.join("\\n");
  tooltip.style.display = "block";
});
cy.on("mousemove", "edge", function(evt) {
  tooltip.style.left = (evt.originalEvent.clientX + 14) + "px";
  tooltip.style.top  = (evt.originalEvent.clientY - 6) + "px";
});
cy.on("mouseout", "edge", function() { tooltip.style.display = "none"; });

function clearHighlight() {
  cy.nodes().removeClass("highlighted dimmed").style("opacity", 1);
  cy.edges().removeClass("highlighted dimmed").style("opacity", 0.75);
}

function showEmpty() {
  document.getElementById("empty-state").style.display = "";
  document.getElementById("node-detail").style.display = "none";
}

function showDetail(cyNode) {
  document.getElementById("empty-state").style.display = "none";
  var detail = document.getElementById("node-detail");
  detail.style.display = "flex";
  detail.style.flexDirection = "column";
  detail.style.gap = "13px";

  var data = cyNode.data();
  var c = LAYER_COLORS[data.layer] || LAYER_COLORS.other;
  var inEdges  = cyNode.incomers("edge");
  var outEdges = cyNode.outgoers("edge");
  var html = "";

  // Header
  html += "<div>";
  html += "<div class='detail-title'>" + esc(data.label) + "</div>";
  html += "<div class='detail-path'>" + esc(data.relPath) + "</div>";
  html += "<span class='layer-badge' style='background:" + c.bg + "'>" + esc(LAYER_LABELS[data.layer] || data.layer) + "</span>";
  html += "</div>";

  // Description
  if (data.description && data.description.length > 0) {
    html += "<div>";
    html += "<div class='section-title'>Description</div>";
    html += "<div class='description-block'>";
    for (var di = 0; di < data.description.length; di++) {
      html += "<p>" + esc(data.description[di]) + "</p>";
    }
    html += "</div></div>";
  }

  // Exports
  if (data.exportNames && data.exportNames.length > 0) {
    html += "<div>";
    html += "<div class='section-title'>Exports (" + data.exportNames.length + ")</div>";
    html += "<ul class='export-list'>";
    for (var ei = 0; ei < data.exportNames.length; ei++) {
      html += "<li>" + esc(data.exportNames[ei]) + "</li>";
    }
    html += "</ul></div>";
  }

  // Uses
  if (outEdges.length > 0) {
    html += "<div>";
    html += "<div class='section-title'>Uses (" + outEdges.length + ")</div>";
    html += "<div class='edge-list'>";
    outEdges.forEach(function(e) {
      var names  = e.data("importedNames") || [];
      var target = e.data("target").split("/").slice(-2).join("/");
      var isType = e.data("isTypeOnly");
      html += "<div class='edge-item'>";
      html += "<div class='edge-file'>" + esc(target) + (isType ? " <span class='edge-type'>[type]</span>" : "") + "</div>";
      if (names.length > 0) html += "<div class='edge-names'>" + esc(names.join(", ")) + "</div>";
      html += "</div>";
    });
    html += "</div></div>";
  }

  // Used by
  if (inEdges.length > 0) {
    html += "<div>";
    html += "<div class='section-title'>Used by (" + inEdges.length + ")</div>";
    html += "<div class='edge-list'>";
    inEdges.forEach(function(e) {
      var names  = e.data("importedNames") || [];
      var source = e.data("source").split("/").slice(-2).join("/");
      var isType = e.data("isTypeOnly");
      html += "<div class='edge-item'>";
      html += "<div class='edge-file'>" + esc(source) + (isType ? " <span class='edge-type'>[type]</span>" : "") + "</div>";
      if (names.length > 0) html += "<div class='edge-names'>" + esc(names.join(", ")) + "</div>";
      html += "</div>";
    });
    html += "</div></div>";
  }

  detail.innerHTML = html;
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
</script>
</body>
</html>`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
