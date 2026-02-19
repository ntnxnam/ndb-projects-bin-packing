/**
 * Dependency graph: nodes = projects, edges = "depends on" (arrow from dependency → dependent).
 * Layout: left-to-right (sources left, dependents right); nodes in columns by layer.
 * Includes legend and clear node labels.
 */

const NODE_WIDTH = 200;
const NODE_HEIGHT = 52;
const LAYER_GAP = 80;
const NODE_GAP = 20;
const PAD = 28;

/**
 * @param {HTMLElement} container
 * @param {Array<{ rowNumber, summary, dependencyRowNumbers, dependencyDevBlockers }>} projects - filtered list (main + children; we use main for nodes)
 * @param {{ childToParent?: Map<number, number> }} options
 */
export function renderDependencyGraph(container, projects, options = {}) {
  if (!container || typeof container.appendChild !== 'function') return;

  try {
    return renderDependencyGraphImpl(container, projects, options);
  } catch (err) {
    container.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'dependency-graph-empty';
    p.textContent = 'Dependency graph error: ' + (err && (err.message || String(err)));
    container.appendChild(p);
    if (typeof window !== 'undefined' && window.__errLog) {
      window.__errLog.push({ msg: err.message || String(err), stack: err.stack });
    }
  }
}

function renderDependencyGraphImpl(container, projects, options) {
  const childToParent = options.childToParent ?? new Map();
  const resolve = (row) => childToParent.get(row) ?? row;

  const main = (projects || []).filter(p => !p.isResourceGroupChild);
  const byRow = new Map(main.map(p => [p.rowNumber, p]));
  const rankOrderIndex = new Map();
  main.forEach((p, i) => rankOrderIndex.set(p.rowNumber, i));

  const edges = [];
  const blockers = (p) => new Set(p.dependencyDevBlockers || []);
  for (const p of main) {
    for (const orig of (p.dependencyRowNumbers || [])) {
      const depRow = resolve(orig);
      if (depRow === p.rowNumber || !byRow.has(depRow)) continue;
      edges.push({ from: depRow, to: p.rowNumber, isBlocker: blockers(p).has(orig) });
    }
  }

  const layers = [];
  const layerOf = new Map();
  const visiting = new Set();
  const assignLayer = (row) => {
    if (layerOf.has(row)) return layerOf.get(row);
    if (visiting.has(row)) {
      layerOf.set(row, 0);
      return 0;
    }
    visiting.add(row);
    const p = byRow.get(row);
    const deps = (p?.dependencyRowNumbers || []).map(resolve).filter(r => byRow.has(r));
    const depLayers = deps.map(r => assignLayer(r));
    const L = deps.length === 0 ? 0 : 1 + Math.max(...depLayers);
    visiting.delete(row);
    layerOf.set(row, L);
    return L;
  };
  for (const p of main) assignLayer(p.rowNumber);
  const maxLayer = main.length ? Math.max(...main.map(p => layerOf.get(p.rowNumber))) : 0;
  for (let L = 0; L <= maxLayer; L++) {
    const layerNodes = main.filter(p => layerOf.get(p.rowNumber) === L);
    layerNodes.sort((a, b) => (rankOrderIndex.get(a.rowNumber) ?? 9999) - (rankOrderIndex.get(b.rowNumber) ?? 9999));
    layers.push(layerNodes);
  }

  /* Left-to-right: each layer is a column; within column, nodes stacked vertically by rank (same as Schedule) */
  const nodePos = new Map();
  let maxY = 0;
  layers.forEach((nodes, layerIdx) => {
    const colX = PAD + layerIdx * (NODE_WIDTH + LAYER_GAP);
    const totalH = nodes.length * NODE_HEIGHT + (nodes.length - 1) * NODE_GAP;
    let y = PAD;
    nodes.forEach(p => {
      nodePos.set(p.rowNumber, { x: colX, y, w: NODE_WIDTH, h: NODE_HEIGHT });
      y += NODE_HEIGHT + NODE_GAP;
    });
    if (totalH > maxY) maxY = totalH;
  });
  const totalW = PAD * 2 + (maxLayer + 1) * NODE_WIDTH + maxLayer * LAYER_GAP;
  const totalH = PAD * 2 + maxY;

  container.innerHTML = '';
  if (main.length === 0) {
    const p = document.createElement('p');
    p.className = 'dependency-graph-empty';
    p.textContent = (projects || []).length === 0
      ? 'No project data yet. Load data from 1. Refresh CSV (upload or use data/projects.json), then open this tab again.'
      : 'No projects in current filter, or none have dependencies. Change Commitment/Priority on 2. Schedule or add dependency data.';
    container.appendChild(p);
    return;
  }

  /* Legend */
  const legend = document.createElement('div');
  legend.className = 'dependency-graph-legend';
  legend.innerHTML = '<span class="dependency-graph-legend-item"><span class="dependency-graph-legend-arrow"></span> Depends on (cannot complete until source is checked in)</span><span class="dependency-graph-legend-item dependency-graph-legend-item--blocker"><span class="dependency-graph-legend-arrow dependency-graph-legend-arrow--blocker"></span> Dev-blocker</span>';
  container.appendChild(legend);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'dependency-graph-svg');
  svg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', `${totalH}px`);
  svg.style.minHeight = '220px';

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'dep-arrow');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '6');
  marker.setAttribute('refY', '4');
  marker.setAttribute('orient', 'auto');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', '0 0, 8 4, 0 8');
  poly.setAttribute('fill', 'var(--muted)');
  marker.appendChild(poly);
  defs.appendChild(marker);
  const markerBlocker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  markerBlocker.setAttribute('id', 'dep-arrow-blocker');
  markerBlocker.setAttribute('markerWidth', '8');
  markerBlocker.setAttribute('markerHeight', '8');
  markerBlocker.setAttribute('refX', '6');
  markerBlocker.setAttribute('refY', '4');
  markerBlocker.setAttribute('orient', 'auto');
  const polyBlocker = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polyBlocker.setAttribute('points', '0 0, 8 4, 0 8');
  polyBlocker.setAttribute('fill', '#d29922');
  markerBlocker.appendChild(polyBlocker);
  defs.appendChild(markerBlocker);
  svg.appendChild(defs);

  /* Edges: from right of source to left of target (left-to-right flow) */
  for (const { from, to, isBlocker } of edges) {
    const a = nodePos.get(from);
    const b = nodePos.get(to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const midX = (x1 + x2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', isBlocker ? '#d29922' : 'var(--muted)');
    path.setAttribute('stroke-width', isBlocker ? '2' : '1');
    path.setAttribute('marker-end', isBlocker ? 'url(#dep-arrow-blocker)' : 'url(#dep-arrow)');
    path.setAttribute('class', isBlocker ? 'dependency-edge dependency-edge--blocker' : 'dependency-edge');
    svg.appendChild(path);
  }

  main.forEach(p => {
    const pos = nodePos.get(p.rowNumber);
    if (!pos) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'dependency-node');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', pos.x);
    rect.setAttribute('y', pos.y);
    rect.setAttribute('width', pos.w);
    rect.setAttribute('height', pos.h);
    rect.setAttribute('rx', '10');
    rect.setAttribute('ry', '10');
    rect.setAttribute('class', 'dependency-node-rect');
    const summary = (p.summary || '').trim();
    const summaryShort = summary.length > 28 ? summary.slice(0, 28) + '…' : summary;
    const labelSl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    labelSl.setAttribute('x', pos.x + 12);
    labelSl.setAttribute('y', pos.y + 20);
    labelSl.setAttribute('class', 'dependency-node-sl');
    labelSl.textContent = `#${p.rowNumber}`;
    const labelSummary = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    labelSummary.setAttribute('x', pos.x + 12);
    labelSummary.setAttribute('y', pos.y + 38);
    labelSummary.setAttribute('class', 'dependency-node-summary');
    labelSummary.textContent = summaryShort || '—';
    g.appendChild(rect);
    g.appendChild(labelSl);
    g.appendChild(labelSummary);
    g.setAttribute('data-row', String(p.rowNumber));
    const depsList = (p.dependencyRowNumbers || []).map(r => resolve(r)).filter(r => byRow.has(r)).join(', ');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${p.rowNumber} – ${p.summary || '—'}\nDepends on: ${depsList || 'none'}`;
    g.appendChild(title);
    svg.appendChild(g);
  });

  container.appendChild(svg);
}
