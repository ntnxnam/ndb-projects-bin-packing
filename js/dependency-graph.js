/**
 * Dependency graph: nodes = projects, edges = "depends on" (arrow from dependency → dependent).
 * Layout: left-to-right (sources left, dependents right); nodes in columns by layer.
 * Includes legend and clear node labels.
 */

const NODE_WIDTH = 200;
const NODE_HEIGHT = 52;
const SL_LABEL_MAX = 32;
const SUMMARY_MAX = 32;
const LAYER_GAP = 80;
const NODE_GAP = 20;
const PAD = 28;

/**
 * @param {HTMLElement} container
 * @param {Array<{ rowNumber, summary, dependencyRowNumbers, dependencyDevBlockers }>} projects - filtered list (main + children; we use main for nodes)
 * @param {{ childToParent?: Map<number, number>, groups?: number[][] }} options - groups: each array is one group (first row = canonical node)
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
  const groups = options.groups ?? [];
  const rowToCanonical = new Map();
  const canonicalToGroup = new Map();
  for (const group of groups) {
    if (group.length === 0) continue;
    const canonical = group[0];
    for (const row of group) rowToCanonical.set(row, canonical);
    canonicalToGroup.set(canonical, group);
  }
  const resolve = (row) => {
    const r = childToParent.get(row) ?? row;
    return rowToCanonical.get(r) ?? r;
  };

  const mainAll = (projects || []).filter(p => !p.isResourceGroupChild);
  const main = mainAll.filter(p => {
    const canonical = rowToCanonical.get(p.rowNumber) ?? p.rowNumber;
    return p.rowNumber === canonical;
  });
  const children = (projects || []).filter(p => p.isResourceGroupChild);
  /* All nodes: main + resource-group children (so shared-pool line items appear with their own deps) */
  const byRow = new Map([...main.map(p => [p.rowNumber, p]), ...children.map(p => [p.rowNumber, p])]);
  const rankOrderIndex = new Map();
  main.forEach((p, i) => rankOrderIndex.set(p.rowNumber, i));
  children.forEach(p => {
    const parentRow = p.resourceGroupParentRow;
    rankOrderIndex.set(p.rowNumber, (rankOrderIndex.get(parentRow) ?? 9999) * 10000 + (p.rowNumber ?? 0));
  });

  /* Effective dependencies per row (main and child) for layer assignment and tooltips */
  const effectiveDepsByRow = new Map();
  for (const p of mainAll) {
    const canon = rowToCanonical.get(p.rowNumber) ?? p.rowNumber;
    if (!byRow.has(canon)) continue;
    let set = effectiveDepsByRow.get(canon);
    if (!set) { set = new Set(); effectiveDepsByRow.set(canon, set); }
    for (const orig of (p.dependencyRowNumbers || [])) {
      const depRow = resolve(orig);
      if (byRow.has(depRow) && depRow !== canon) set.add(depRow);
    }
  }
  for (const p of children) {
    if (!byRow.has(p.rowNumber)) continue;
    let set = effectiveDepsByRow.get(p.rowNumber);
    if (!set) { set = new Set(); effectiveDepsByRow.set(p.rowNumber, set); }
    for (const orig of (p.dependencyRowNumbers || [])) {
      const depRow = childToParent.has(orig) ? childToParent.get(orig) : orig;
      const resolved = rowToCanonical.get(depRow) ?? depRow;
      if (byRow.has(resolved) && resolved !== p.rowNumber) set.add(resolved);
      if (byRow.has(orig) && orig !== p.rowNumber) set.add(orig);
    }
  }

  const edges = [];
  const blockers = (p) => new Set(p.dependencyDevBlockers || []);
  const edgeKey = (from, to) => `${from}\t${to}`;
  const edgeBlocker = new Map();
  const seen = new Set();

  function addEdge(from, to, isBlockerVal) {
    const key = edgeKey(from, to);
    if (seen.has(key)) {
      if (isBlockerVal) edgeBlocker.set(key, true);
      return;
    }
    seen.add(key);
    edges.push({ from, to, isBlocker: isBlockerVal });
    edgeBlocker.set(key, edgeBlocker.get(key) || isBlockerVal);
  }

  /* Edges: dependency → dependent. Both main and children can be source or target. */
  function depRowAsNode(orig) {
    if (byRow.has(orig)) return orig;
    const r = resolve(orig);
    return byRow.has(r) ? r : null;
  }
  for (const p of mainAll) {
    const toRow = rowToCanonical.get(p.rowNumber) ?? p.rowNumber;
    if (!byRow.has(toRow)) continue;
    for (const orig of (p.dependencyRowNumbers || [])) {
      const fromRow = depRowAsNode(orig);
      if (fromRow == null || fromRow === toRow) continue;
      addEdge(fromRow, toRow, blockers(p).has(orig));
    }
  }
  for (const p of children) {
    if (!byRow.has(p.rowNumber)) continue;
    const toRow = p.rowNumber;
    for (const orig of (p.dependencyRowNumbers || [])) {
      const fromRow = depRowAsNode(orig);
      if (fromRow == null || fromRow === toRow) continue;
      addEdge(fromRow, toRow, blockers(p).has(orig));
    }
  }
  /* Edges from children when others depend on them (e.g. #8 depends on #60) */
  for (const p of mainAll) {
    const toRow = rowToCanonical.get(p.rowNumber) ?? p.rowNumber;
    if (!byRow.has(toRow)) continue;
    for (const orig of (p.dependencyRowNumbers || [])) {
      if (!byRow.has(orig)) continue;
      if (orig === toRow) continue;
      addEdge(orig, toRow, blockers(p).has(orig));
    }
  }
  edges.forEach(e => {
    e.isBlocker = !!edgeBlocker.get(edgeKey(e.from, e.to));
  });

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
    const deps = effectiveDepsByRow.get(row) ? [...effectiveDepsByRow.get(row)] : [];
    const depLayers = deps.map(r => assignLayer(r));
    const L = deps.length === 0 ? 0 : 1 + Math.max(0, ...depLayers);
    visiting.delete(row);
    layerOf.set(row, L);
    return L;
  };
  for (const row of byRow.keys()) assignLayer(row);
  const allNodes = [...main, ...children];
  const maxLayer = allNodes.length ? Math.max(...allNodes.map(p => layerOf.get(p.rowNumber) ?? 0)) : 0;
  for (let L = 0; L <= maxLayer; L++) {
    const layerNodes = allNodes.filter(p => layerOf.get(p.rowNumber) === L);
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
  if (byRow.size === 0) {
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
  legend.innerHTML = '<span class="dependency-graph-legend-item"><span class="dependency-graph-legend-arrow"></span> Depends on (cannot complete until source is checked in)</span><span class="dependency-graph-legend-item dependency-graph-legend-item--blocker"><span class="dependency-graph-legend-arrow dependency-graph-legend-arrow--blocker"></span> Dev-blocker</span><span class="dependency-graph-legend-item dependency-graph-legend-item--resource-group"><span class="dependency-graph-legend-node dependency-graph-legend-node--resource-group"></span> Shared pool (combined effort)</span><span class="dependency-graph-legend-item dependency-graph-legend-item--multi-line"><span class="dependency-graph-legend-node dependency-graph-legend-node--multi-line"></span> Multiple line items (effort per row)</span>';
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

  /* Edges: fan out by layer-pair index to reduce railroad overlap; softer non-blocker stroke */
  const layerPairCount = new Map();
  const edgeIndexByKey = new Map();
  for (const e of edges) {
    const lFrom = layerOf.get(e.from) ?? 0;
    const lTo = layerOf.get(e.to) ?? 0;
    const key = `${lFrom}-${lTo}`;
    const idx = layerPairCount.get(key) ?? 0;
    edgeIndexByKey.set(edgeKey(e.from, e.to), idx);
    layerPairCount.set(key, idx + 1);
  }
  for (const { from, to, isBlocker } of edges) {
    const a = nodePos.get(from);
    const b = nodePos.get(to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const midX = (x1 + x2) / 2;
    const lFrom = layerOf.get(from) ?? 0;
    const lTo = layerOf.get(to) ?? 0;
    const key = `${lFrom}-${lTo}`;
    const n = layerPairCount.get(key) ?? 1;
    const idx = edgeIndexByKey.get(edgeKey(from, to)) ?? 0;
    const offset = n <= 1 ? 0 : ((idx - (n - 1) / 2) * 8);
    const cpy1 = y1 + offset;
    const cpy2 = y2 + offset;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${midX} ${cpy1}, ${midX} ${cpy2}, ${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', isBlocker ? '#d29922' : 'var(--muted)');
    path.setAttribute('stroke-width', isBlocker ? '2' : '1');
    path.setAttribute('stroke-dasharray', isBlocker ? '6 4' : '8 6');
    path.setAttribute('stroke-opacity', isBlocker ? '1' : '0.65');
    path.setAttribute('marker-end', isBlocker ? 'url(#dep-arrow-blocker)' : 'url(#dep-arrow)');
    path.setAttribute('class', isBlocker ? 'dependency-edge dependency-edge--blocker' : 'dependency-edge');
    svg.appendChild(path);
  }

  main.forEach(p => {
    const pos = nodePos.get(p.rowNumber);
    if (!pos) return;
    const isResourceGroup = !!(p.resourceGroupChildRows && p.resourceGroupChildRows.length > 0);
    const groupArrForLabel = canonicalToGroup.get(p.rowNumber);
    const isMultiLineGroup = groupArrForLabel && groupArrForLabel.length > 1;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    let nodeClass = 'dependency-node';
    if (isResourceGroup) nodeClass += ' dependency-node--resource-group';
    if (isMultiLineGroup) nodeClass += ' dependency-node--multi-line';
    g.setAttribute('class', nodeClass);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', pos.x);
    rect.setAttribute('y', pos.y);
    rect.setAttribute('width', pos.w);
    rect.setAttribute('height', pos.h);
    rect.setAttribute('rx', '10');
    rect.setAttribute('ry', '10');
    rect.setAttribute('class', 'dependency-node-rect');
    const summary = (p.summary || '').trim();
    const summaryShort = summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX) + '…' : summary;
    const bucketName = p.resourceGroupName || '';
    let slLabel = isResourceGroup
      ? (bucketName ? `${bucketName} (#${p.rowNumber})` : `#${p.rowNumber} (shared pool)`)
      : isMultiLineGroup
        ? `#${p.rowNumber} (multiple line items)`
        : `#${p.rowNumber}`;
    if (slLabel.length > SL_LABEL_MAX) slLabel = slLabel.slice(0, SL_LABEL_MAX) + '…';
    const clipId = `dep-clip-${p.rowNumber}`;
    const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    clip.setAttribute('id', clipId);
    const clipRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    clipRect.setAttribute('x', pos.x);
    clipRect.setAttribute('y', pos.y);
    clipRect.setAttribute('width', pos.w);
    clipRect.setAttribute('height', pos.h);
    clipRect.setAttribute('rx', '10');
    clipRect.setAttribute('ry', '10');
    clip.appendChild(clipRect);
    defs.appendChild(clip);
    g.setAttribute('clip-path', `url(#${clipId})`);
    const labelSl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    labelSl.setAttribute('x', pos.x + 12);
    labelSl.setAttribute('y', pos.y + 20);
    labelSl.setAttribute('class', 'dependency-node-sl');
    labelSl.textContent = slLabel;
    const labelSummary = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    labelSummary.setAttribute('x', pos.x + 12);
    labelSummary.setAttribute('y', pos.y + 38);
    labelSummary.setAttribute('class', 'dependency-node-summary');
    labelSummary.textContent = summaryShort || '—';
    g.appendChild(rect);
    g.appendChild(labelSl);
    g.appendChild(labelSummary);
    g.setAttribute('data-row', String(p.rowNumber));
    const effectiveDeps = effectiveDepsByRow.get(p.rowNumber);
    const blockers = new Set(p.dependencyDevBlockers || []);
    const isBlocker = (resolvedRow) => blockers.has(resolvedRow) || (p.dependencyRowNumbers || []).some(orig => resolve(orig) === resolvedRow && blockers.has(orig));
    const depsList = effectiveDeps
      ? [...effectiveDeps].sort((a, b) => a - b).map(r => isBlocker(r) ? `${r} (Dev-blocker)` : `${r}`).join(', ')
      : '';
    const groupArr = canonicalToGroup.get(p.rowNumber);
    const groupNote = groupArr && groupArr.length > 1
      ? `\nMultiple line items (effort per row): ${groupArr.join(', ')}`
      : isResourceGroup && p.resourceGroupChildRows?.length
        ? `\nBucket "${bucketName || p.rowNumber}" (${p.resourceGroupChildRows.length} sub-projects)`
        : '';
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `#${p.rowNumber} – ${p.summary || '—'}${groupNote}\nDepends on: ${depsList || 'none'}`;
    g.appendChild(title);
    svg.appendChild(g);
  });

  /* Resource-group (shared pool) child nodes: show line items and their interdependencies */
  children.forEach(p => {
    const pos = nodePos.get(p.rowNumber);
    if (!pos) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'dependency-node dependency-node--pool-child');
    g.setAttribute('data-row', String(p.rowNumber));

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', pos.x);
    rect.setAttribute('y', pos.y);
    rect.setAttribute('width', pos.w);
    rect.setAttribute('height', pos.h);
    rect.setAttribute('rx', '8');
    rect.setAttribute('ry', '8');
    rect.setAttribute('class', 'dependency-node-rect');
    const summary = (p.summary || '').trim();
    const summaryShort = summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX) + '…' : summary;
    const bucketNameChild = p.resourceGroupName || '';
    let slLabelChild = bucketNameChild ? `#${p.rowNumber} (${bucketNameChild})` : `#${p.rowNumber} (pool of #${p.resourceGroupParentRow})`;
    if (slLabelChild.length > SL_LABEL_MAX) slLabelChild = slLabelChild.slice(0, SL_LABEL_MAX) + '…';
    const clipIdChild = `dep-clip-child-${p.rowNumber}`;
    const clipChild = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    clipChild.setAttribute('id', clipIdChild);
    const clipRectChild = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    clipRectChild.setAttribute('x', pos.x);
    clipRectChild.setAttribute('y', pos.y);
    clipRectChild.setAttribute('width', pos.w);
    clipRectChild.setAttribute('height', pos.h);
    clipRectChild.setAttribute('rx', '8');
    clipRectChild.setAttribute('ry', '8');
    clipChild.appendChild(clipRectChild);
    defs.appendChild(clipChild);
    g.setAttribute('clip-path', `url(#${clipIdChild})`);
    const labelSl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    labelSl.setAttribute('x', pos.x + 12);
    labelSl.setAttribute('y', pos.y + 20);
    labelSl.setAttribute('class', 'dependency-node-sl');
    labelSl.textContent = slLabelChild;
    const labelSummary = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    labelSummary.setAttribute('x', pos.x + 12);
    labelSummary.setAttribute('y', pos.y + 38);
    labelSummary.setAttribute('class', 'dependency-node-summary');
    labelSummary.textContent = summaryShort || '—';
    const effectiveDeps = effectiveDepsByRow.get(p.rowNumber);
    const blockers = new Set(p.dependencyDevBlockers || []);
    const isBlocker = (resolvedRow) => blockers.has(resolvedRow) || (p.dependencyRowNumbers || []).some(orig => (childToParent.get(orig) ?? orig) === resolvedRow && blockers.has(orig));
    const depsList = effectiveDeps
      ? [...effectiveDeps].sort((a, b) => a - b).map(r => isBlocker(r) ? `${r} (Dev-blocker)` : `${r}`).join(', ')
      : '';
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `#${p.rowNumber} – ${p.summary || '—'}\nPart of bucket "${bucketNameChild || p.resourceGroupParentRow}" (parent #${p.resourceGroupParentRow})\nDepends on: ${depsList || 'none'}`;
    g.appendChild(rect);
    g.appendChild(labelSl);
    g.appendChild(labelSummary);
    g.appendChild(title);
    svg.appendChild(g);
  });

  container.appendChild(svg);
}
