/**
 * Dependencies page: render dependency graph with optional commitment/priority filters.
 * @module dependencies
 */

import { getEl } from './utils.js';
import { logger } from './logger.js';
import { UPLOAD_STORAGE_KEY } from './config.js';
import { getProjects, getFilters, setFilters } from './state.js';
import { filterByCommitment, filterByPriority } from './filters.js';
import { orderByDependencyAndSize } from './ranking.js';
import { renderDependencyGraph } from './dependency-graph.js';
import { detectResourceGroups } from './resource-groups.js';

/**
 * Load project list: from state, or fallback to localStorage parse (with detectResourceGroups).
 * @returns {Array<object>}
 */
function getProjectList() {
  let list = getProjects();
  if (list.length > 0) return list;
  try {
    const raw = localStorage.getItem(UPLOAD_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        detectResourceGroups(parsed);
        return parsed;
      }
    }
  } catch (_) {}
  return [];
}

/**
 * Read filter state from this page's selects.
 * @returns {{ commitment: string, priority: string }}
 */
function getFilterState() {
  const commitment = (getEl('depCommitment')?.value || '').trim();
  const priority = (getEl('depPriority')?.value || '').trim();
  return { commitment, priority };
}

/**
 * Render the dependency graph for the current project list and filters.
 */
function render() {
  const listToUse = getProjectList();
  const { commitment, priority } = getFilterState();
  setFilters({ commitment, priority });

  let filtered = filterByCommitment(listToUse, commitment);
  filtered = filterByPriority(filtered, priority);

  const childToParent = new Map();
  filtered.forEach(p => {
    if (p.isResourceGroupChild && p.resourceGroupParentRow != null) {
      childToParent.set(p.rowNumber, p.resourceGroupParentRow);
    }
  });

  const depGraphEl = getEl('dependencyGraph');
  if (depGraphEl) {
    renderDependencyGraph(depGraphEl, orderByDependencyAndSize(filtered), { childToParent });
    logger.debug('dependencies.render: rendered graph for', filtered.length, 'projects');
  }
}

function bindControls() {
  const commitmentEl = getEl('depCommitment');
  const priorityEl = getEl('depPriority');
  if (commitmentEl) commitmentEl.addEventListener('change', render);
  if (priorityEl) priorityEl.addEventListener('change', render);
}

/**
 * Pre-fill filters from stored state.
 */
function applyStoredFilters() {
  const f = getFilters();
  const commitmentEl = getEl('depCommitment');
  const priorityEl = getEl('depPriority');
  if (commitmentEl && f.commitment) commitmentEl.value = f.commitment;
  if (priorityEl && f.priority) priorityEl.value = f.priority;
}

function init() {
  bindControls();
  applyStoredFilters();
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
