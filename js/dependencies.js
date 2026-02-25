/**
 * Dependencies page: render dependency graph.
 * Data is schedule-ready (Committed-only) from prepare-schedule pipeline.
 * @module dependencies
 */

import { getEl } from './utils.js';
import { getScheduleData } from './state.js';
import { orderByDependencyAndSize } from './ranking.js';
import { renderDependencyGraph } from './dependency-graph.js';

function render() {
  const projects = getScheduleData();

  const childToParent = new Map();
  projects.forEach(p => {
    if (p.isResourceGroupChild && p.resourceGroupParentRow != null) {
      childToParent.set(p.rowNumber, p.resourceGroupParentRow);
    }
  });

  const depGraphEl = getEl('dependencyGraph');
  if (depGraphEl) {
    renderDependencyGraph(depGraphEl, orderByDependencyAndSize(projects), { childToParent });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}
