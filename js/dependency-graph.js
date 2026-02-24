/**
 * Dependency graph: compact DAG visualization.
 * - Only shows projects with dependencies (orphans summarized in a count)
 * - Groups connected components as separate clusters
 * - Crossing minimization via barycenter heuristic
 * - Orthogonal edge routing (right-angle connectors)
 * - Critical chain highlighted
 * - Hover on node highlights full ancestor/descendant chain
 */

const NODE_W = 210;
const NODE_H = 48;
const LAYER_GAP = 100;
const NODE_GAP = 14;
const PAD = 24;
const SUMMARY_MAX = 30;

/**
 * @param {HTMLElement} container
 * @param {Array<object>} projects
 * @param {{ childToParent?: Map<number, number> }} options
 */
export function renderDependencyGraph(container, projects, options = {}) {
  if (!container) return;
  try {
    renderImpl(container, projects || [], options);
  } catch (err) {
    container.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'depgraph-empty';
    p.textContent = 'Dependency graph error: ' + (err?.message || String(err));
    container.appendChild(p);
  }
}

function renderImpl(container, projects, options) {
  const childToParent = options.childToParent ?? new Map();
  const resolve = (row) => childToParent.get(row) ?? row;

  /* Build node set: only main projects (not resource-group children) */
  const main = projects.filter(p => !p.isResourceGroupChild);
  const byRow = new Map(main.map(p => [p.rowNumber, p]));

  /* Build edge list */
  const edges = [];
  const edgeSet = new Set();
  const successors = new Map();
  const predecessors = new Map();

  for (const p of main) {
    const to = p.rowNumber;
    const devBlockers = new Set(p.dependencyDevBlockers || []);
    for (const orig of (p.dependencyRowNumbers || [])) {
      const from = resolve(orig);
      if (!byRow.has(from) || from === to) continue;
      const key = `${from}-${to}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ from, to, isBlocker: devBlockers.has(orig) });
      if (!successors.has(from)) successors.set(from, []);
      successors.get(from).push(to);
      if (!predecessors.has(to)) predecessors.set(to, []);
      predecessors.get(to).push(from);
    }
  }

  /* Separate orphans (no edges) from connected nodes */
  const connectedRows = new Set();
  for (const e of edges) { connectedRows.add(e.from); connectedRows.add(e.to); }
  const orphanCount = main.length - connectedRows.size;
  const connected = main.filter(p => connectedRows.has(p.rowNumber));

  container.innerHTML = '';
  if (connected.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'depgraph-empty';
    msg.textContent = main.length === 0
      ? 'No project data. Load data from 1. Refresh data, then open this tab.'
      : `${main.length} projects loaded — none have dependencies on each other.`;
    container.appendChild(msg);
    return;
  }

  /* --- Find connected components --- */
  const visited = new Set();
  const components = [];
  function bfs(startRow) {
    const comp = [];
    const queue = [startRow];
    visited.add(startRow);
    while (queue.length > 0) {
      const row = queue.shift();
      comp.push(row);
      for (const next of (successors.get(row) || [])) {
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
      for (const prev of (predecessors.get(row) || [])) {
        if (!visited.has(prev)) { visited.add(prev); queue.push(prev); }
      }
    }
    return comp;
  }
  for (const row of connectedRows) {
    if (!visited.has(row)) components.push(bfs(row));
  }
  components.sort((a, b) => b.length - a.length);

  /* --- Layer assignment per component (longest path from sources) --- */
  function assignLayers(compRows) {
    const rows = new Set(compRows);
    const layerOf = new Map();
    const memo = new Map();
    function longestPath(row) {
      if (memo.has(row)) return memo.get(row);
      memo.set(row, 0);
      const preds = (predecessors.get(row) || []).filter(r => rows.has(r));
      let maxP = -1;
      for (const p of preds) {
        maxP = Math.max(maxP, longestPath(p));
      }
      const L = maxP + 1;
      memo.set(row, L);
      layerOf.set(row, L);
      return L;
    }
    for (const row of compRows) longestPath(row);
    return layerOf;
  }

  /* --- Barycenter crossing minimization --- */
  function minimizeCrossings(layers, succs, preds) {
    for (let pass = 0; pass < 4; pass++) {
      /* Forward sweep */
      for (let li = 1; li < layers.length; li++) {
        const prev = layers[li - 1];
        const posInPrev = new Map(prev.map((r, i) => [r, i]));
        layers[li].sort((a, b) => {
          const predsA = (preds.get(a) || []).filter(r => posInPrev.has(r));
          const predsB = (preds.get(b) || []).filter(r => posInPrev.has(r));
          const baryA = predsA.length > 0 ? predsA.reduce((s, r) => s + posInPrev.get(r), 0) / predsA.length : Infinity;
          const baryB = predsB.length > 0 ? predsB.reduce((s, r) => s + posInPrev.get(r), 0) / predsB.length : Infinity;
          return baryA - baryB;
        });
      }
      /* Backward sweep */
      for (let li = layers.length - 2; li >= 0; li--) {
        const next = layers[li + 1];
        const posInNext = new Map(next.map((r, i) => [r, i]));
        layers[li].sort((a, b) => {
          const succsA = (succs.get(a) || []).filter(r => posInNext.has(r));
          const succsB = (succs.get(b) || []).filter(r => posInNext.has(r));
          const baryA = succsA.length > 0 ? succsA.reduce((s, r) => s + posInNext.get(r), 0) / succsA.length : Infinity;
          const baryB = succsB.length > 0 ? succsB.reduce((s, r) => s + posInNext.get(r), 0) / succsB.length : Infinity;
          return baryA - baryB;
        });
      }
    }
  }

  /* --- Critical chain: longest path through the graph by number of edges --- */
  function findCriticalChain(compRows) {
    const rows = new Set(compRows);
    const dist = new Map();
    const parent = new Map();
    for (const r of compRows) { dist.set(r, 0); parent.set(r, null); }

    /* Topological order */
    const topo = [];
    const inDeg = new Map();
    for (const r of compRows) inDeg.set(r, 0);
    for (const e of edges) {
      if (rows.has(e.from) && rows.has(e.to)) {
        inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
      }
    }
    const queue = [...compRows].filter(r => (inDeg.get(r) || 0) === 0);
    while (queue.length > 0) {
      const r = queue.shift();
      topo.push(r);
      for (const s of (successors.get(r) || [])) {
        if (!rows.has(s)) continue;
        inDeg.set(s, inDeg.get(s) - 1);
        if (inDeg.get(s) === 0) queue.push(s);
      }
    }

    for (const r of topo) {
      for (const s of (successors.get(r) || [])) {
        if (!rows.has(s)) continue;
        if (dist.get(r) + 1 > dist.get(s)) {
          dist.set(s, dist.get(r) + 1);
          parent.set(s, r);
        }
      }
    }

    let endNode = compRows[0];
    for (const r of compRows) {
      if (dist.get(r) > dist.get(endNode)) endNode = r;
    }

    const chain = new Set();
    let cur = endNode;
    while (cur != null) {
      chain.add(cur);
      cur = parent.get(cur);
    }
    return chain;
  }

  /* --- Layout all components vertically stacked --- */
  const nodePos = new Map();
  let globalOffsetY = PAD;
  const criticalNodes = new Set();
  const compBounds = [];

  for (const compRows of components) {
    const layerOf = assignLayers(compRows);
    const maxLayer = Math.max(0, ...compRows.map(r => layerOf.get(r)));
    const layers = Array.from({ length: maxLayer + 1 }, () => []);
    for (const r of compRows) layers[layerOf.get(r)].push(r);

    minimizeCrossings(layers, successors, predecessors);

    const chain = findCriticalChain(compRows);
    for (const r of chain) criticalNodes.add(r);

    let compMaxY = 0;
    for (let li = 0; li < layers.length; li++) {
      const x = PAD + li * (NODE_W + LAYER_GAP);
      for (let ni = 0; ni < layers[li].length; ni++) {
        const row = layers[li][ni];
        const y = globalOffsetY + ni * (NODE_H + NODE_GAP);
        nodePos.set(row, { x, y, w: NODE_W, h: NODE_H });
        compMaxY = Math.max(compMaxY, y + NODE_H);
      }
    }

    compBounds.push({ top: globalOffsetY, bottom: compMaxY, layers: layers.length });
    globalOffsetY = compMaxY + NODE_GAP * 3;
  }

  const totalW = PAD * 2 + Math.max(1, ...components.map(c => {
    const maxL = Math.max(0, ...c.map(r => nodePos.get(r)?.x ?? 0));
    return maxL + NODE_W;
  }));
  const totalH = globalOffsetY + PAD;

  /* --- Render SVG --- */
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'depgraph-svg');
  svg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', `${totalH}px`);
  svg.style.minHeight = '200px';

  /* Arrow markers */
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  function makeMarker(id, color) {
    const m = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    m.setAttribute('id', id);
    m.setAttribute('markerWidth', '7');
    m.setAttribute('markerHeight', '7');
    m.setAttribute('refX', '6');
    m.setAttribute('refY', '3.5');
    m.setAttribute('orient', 'auto');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', '0 0, 7 3.5, 0 7');
    poly.setAttribute('fill', color);
    m.appendChild(poly);
    return m;
  }
  defs.appendChild(makeMarker('depg-arrow', 'rgba(139,148,158,0.6)'));
  defs.appendChild(makeMarker('depg-arrow-blocker', 'rgba(210,153,34,0.8)'));
  defs.appendChild(makeMarker('depg-arrow-critical', 'rgba(88,166,255,0.8)'));
  svg.appendChild(defs);

  /* Component separator lines */
  for (let ci = 0; ci < compBounds.length - 1; ci++) {
    const midY = (compBounds[ci].bottom + compBounds[ci + 1].top) / 2;
    const sep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    sep.setAttribute('x1', PAD);
    sep.setAttribute('y1', midY);
    sep.setAttribute('x2', totalW - PAD);
    sep.setAttribute('y2', midY);
    sep.setAttribute('stroke', 'rgba(110,118,129,0.15)');
    sep.setAttribute('stroke-width', '1');
    sep.setAttribute('stroke-dasharray', '4,4');
    svg.appendChild(sep);
  }

  /* --- Edges: orthogonal routing --- */
  const edgeElements = [];
  for (const e of edges) {
    const a = nodePos.get(e.from);
    const b = nodePos.get(e.to);
    if (!a || !b) continue;

    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const midX = (x1 + x2) / 2;

    const isCritical = criticalNodes.has(e.from) && criticalNodes.has(e.to);
    let color, width, marker, dasharray, opacity;
    if (isCritical) {
      color = 'rgba(88,166,255,0.7)';
      width = '2.5';
      marker = 'url(#depg-arrow-critical)';
      dasharray = '';
      opacity = '1';
    } else if (e.isBlocker) {
      color = 'rgba(210,153,34,0.65)';
      width = '1.8';
      marker = 'url(#depg-arrow-blocker)';
      dasharray = '';
      opacity = '1';
    } else {
      color = 'rgba(139,148,158,0.4)';
      width = '1';
      marker = 'url(#depg-arrow)';
      dasharray = '5,3';
      opacity = '0.8';
    }

    /* Orthogonal path: right → down/up → right */
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', width);
    path.setAttribute('stroke-dasharray', dasharray);
    path.setAttribute('stroke-opacity', opacity);
    path.setAttribute('marker-end', marker);
    path.setAttribute('stroke-linejoin', 'round');
    path.classList.add('depgraph-edge');
    path.dataset.from = e.from;
    path.dataset.to = e.to;

    svg.appendChild(path);
    edgeElements.push({ el: path, from: e.from, to: e.to });
  }

  /* --- Nodes --- */
  const nodeElements = new Map();
  for (const p of connected) {
    const pos = nodePos.get(p.rowNumber);
    if (!pos) continue;
    const isCritical = criticalNodes.has(p.rowNumber);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('depgraph-node');
    if (isCritical) g.classList.add('depgraph-node--critical');
    g.dataset.row = p.rowNumber;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', pos.x);
    rect.setAttribute('y', pos.y);
    rect.setAttribute('width', pos.w);
    rect.setAttribute('height', pos.h);
    rect.setAttribute('rx', '8');
    rect.setAttribute('ry', '8');
    rect.classList.add('depgraph-node-rect');

    const summary = (p.summary || '').trim();
    const short = summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX) + '…' : summary;
    const groupName = p.resourceGroupName || '';
    const label = groupName ? `#${p.rowNumber} · ${groupName}` : `#${p.rowNumber}`;
    const labelTrunc = label.length > 32 ? label.slice(0, 30) + '…' : label;

    const textSl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    textSl.setAttribute('x', pos.x + 10);
    textSl.setAttribute('y', pos.y + 18);
    textSl.classList.add('depgraph-node-id');
    textSl.textContent = labelTrunc;

    const textSummary = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    textSummary.setAttribute('x', pos.x + 10);
    textSummary.setAttribute('y', pos.y + 35);
    textSummary.classList.add('depgraph-node-summary');
    textSummary.textContent = short || '—';

    /* Tooltip */
    const blockerSet = new Set(p.dependencyDevBlockers || []);
    const depList = (p.dependencyRowNumbers || [])
      .filter(r => r !== p.rowNumber && byRow.has(resolve(r)))
      .map(r => blockerSet.has(r) ? `${resolve(r)} (dev-blocker)` : `${resolve(r)}`);
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `#${p.rowNumber} – ${summary}\nDepends on: ${depList.length ? depList.join(', ') : 'none'}${isCritical ? '\n★ On critical chain' : ''}`;

    g.appendChild(rect);
    g.appendChild(textSl);
    g.appendChild(textSummary);
    g.appendChild(title);
    svg.appendChild(g);
    nodeElements.set(p.rowNumber, g);
  }

  /* --- Hover: highlight full chain (ancestors + descendants) --- */
  function getChain(row) {
    const chain = new Set();
    chain.add(row);
    /* Upstream (predecessors) */
    const upQueue = [row];
    while (upQueue.length > 0) {
      const r = upQueue.shift();
      for (const p of (predecessors.get(r) || [])) {
        if (!chain.has(p) && nodePos.has(p)) { chain.add(p); upQueue.push(p); }
      }
    }
    /* Downstream (successors) */
    const downQueue = [row];
    while (downQueue.length > 0) {
      const r = downQueue.shift();
      for (const s of (successors.get(r) || [])) {
        if (!chain.has(s) && nodePos.has(s)) { chain.add(s); downQueue.push(s); }
      }
    }
    return chain;
  }

  function highlightChain(row) {
    const chain = getChain(row);
    for (const [r, g] of nodeElements) {
      g.classList.toggle('depgraph-node--dimmed', !chain.has(r));
      g.classList.toggle('depgraph-node--highlighted', chain.has(r));
    }
    for (const { el, from, to } of edgeElements) {
      const inChain = chain.has(from) && chain.has(to);
      el.classList.toggle('depgraph-edge--dimmed', !inChain);
      el.classList.toggle('depgraph-edge--highlighted', inChain);
    }
  }

  function clearHighlight() {
    for (const [, g] of nodeElements) {
      g.classList.remove('depgraph-node--dimmed', 'depgraph-node--highlighted');
    }
    for (const { el } of edgeElements) {
      el.classList.remove('depgraph-edge--dimmed', 'depgraph-edge--highlighted');
    }
  }

  for (const [row, g] of nodeElements) {
    g.addEventListener('mouseenter', () => highlightChain(row));
    g.addEventListener('mouseleave', clearHighlight);
    g.style.cursor = 'pointer';
  }

  /* --- Legend + orphan summary --- */
  const legend = document.createElement('div');
  legend.className = 'depgraph-legend';

  const items = [
    '<span class="depgraph-legend-item"><span class="depgraph-legend-line depgraph-legend-line--critical"></span> Critical chain (longest dependency path)</span>',
    '<span class="depgraph-legend-item"><span class="depgraph-legend-line depgraph-legend-line--blocker"></span> Dev-blocker</span>',
    '<span class="depgraph-legend-item"><span class="depgraph-legend-line depgraph-legend-line--plain"></span> Other dependency</span>',
  ];
  if (orphanCount > 0) {
    items.push(`<span class="depgraph-legend-item depgraph-legend-item--muted">${orphanCount} project${orphanCount > 1 ? 's' : ''} with no dependencies (not shown)</span>`);
  }
  items.push(`<span class="depgraph-legend-item depgraph-legend-item--muted">Hover a node to trace its full chain</span>`);
  legend.innerHTML = items.join('');
  container.appendChild(legend);

  /* Component labels */
  if (components.length > 1) {
    for (let ci = 0; ci < components.length; ci++) {
      const firstRow = components[ci][0];
      const firstPos = nodePos.get(firstRow);
      if (!firstPos) continue;
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', PAD);
      label.setAttribute('y', firstPos.y - 6);
      label.setAttribute('fill', 'rgba(200,210,225,0.35)');
      label.setAttribute('font-size', '10');
      label.textContent = `Chain ${ci + 1} (${components[ci].length} projects)`;
      svg.appendChild(label);
    }
  }

  container.appendChild(svg);
}
