/**
 * Project ranking and dependency-display helpers.
 * Re-exports ordering/counts from bin-packing and adds display-oriented helpers.
 * @module ranking
 */

import { orderByDependencyAndSize, getDependentsCounts } from './bin-packing.js';
import { logger } from './logger.js';

// Re-export for consumers that want a single "ranking" entry point.
export { orderByDependencyAndSize, getDependentsCounts };

/**
 * Map each project rowNumber to lists of dependents: who lists this project as dev-blocker vs plain dependency.
 * Used for tooltips and display order (blockers first).
 * @param {Array<object>} projectList
 * @returns {Map<number, { devBlockerFor: number[], plainDepFor: number[] }>}
 */
export function getDependentsByProject(projectList) {
  const map = new Map();
  const list = projectList || [];
  for (const p of list) {
    const r = p.rowNumber;
    if (r == null) continue;
    map.set(r, { devBlockerFor: [], plainDepFor: [] });
  }
  for (const p of list) {
    const r = p.rowNumber;
    if (r == null) continue;
    const blockers = new Set(p.dependencyDevBlockers || []);
    const deps = p.dependencyRowNumbers || [];
    for (const depRow of deps) {
      if (depRow === r || !map.has(depRow)) continue;
      const entry = map.get(depRow);
      const slNo = p.rowNumber != null ? p.rowNumber : null;
      if (slNo == null) continue;
      if (blockers.has(depRow)) {
        if (!entry.devBlockerFor.includes(slNo)) entry.devBlockerFor.push(slNo);
      } else {
        if (!entry.plainDepFor.includes(slNo)) entry.plainDepFor.push(slNo);
      }
    }
  }
  logger.debug('ranking.getDependentsByProject: built map for', list.length, 'projects');
  return map;
}

/**
 * Human-readable rank label for a project (e.g. "0 (In Progress)", "1 (3)", "2 (2)", "3").
 * @param {object} project - Project with rowNumber, inProgress, resourceGroupChildRows, resourceGroupParentRow, resourceGroupName.
 * @param {{ devBlockerDependentsCount: Map<number, number>, plainDependentsCount: Map<number, number> }} counts - From getDependentsCounts.
 * @returns {string}
 */
export function getRankLabel(project, counts) {
  const blockCount = counts.devBlockerDependentsCount.get(project.rowNumber) ?? 0;
  const plainCount = counts.plainDependentsCount.get(project.rowNumber) ?? 0;
  const isInProgress = !!project.inProgress;
  const isChild = !!project.isResourceGroupChild;
  const isParent = !!(project.resourceGroupChildRows?.length);
  let rankText = isInProgress ? '0 (In Progress)' : blockCount > 0 ? `1 (${blockCount})` : plainCount > 0 ? `2 (${plainCount})` : '3';
  const bucketName = project.resourceGroupName || '';
  const groupNote = isChild
    ? (bucketName ? ` [↳ ${bucketName}]` : ` [↳ group of ${project.resourceGroupParentRow}]`)
    : isParent
      ? (bucketName ? ` [📦 ${bucketName}: ${project.resourceGroupChildRows.length} sub]` : ` [📦 group: ${project.resourceGroupChildRows.length} sub]`)
      : '';
  return rankText + groupNote;
}

/**
 * Reorder schedule for display so dev-blockers (projects others wait on) appear on top.
 * Keeps resource-group parent+children together as blocks.
 * @param {Array<object>} schedule - Schedule entries (project, startDate, endDate, …).
 * @param {Map<number, { devBlockerFor: number[], plainDepFor: number[] }>} [dependentsByProject]
 * @returns {Array<object>}
 */
export function orderScheduleByBlockersFirst(schedule, dependentsByProject) {
  if (!schedule?.length) return schedule;
  const blocks = [];
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    if (entry.isResourceGroupChild) {
      blocks[blocks.length - 1].entries.push(entry);
    } else {
      blocks.push({ entries: [entry] });
    }
  }
  const deps = dependentsByProject || new Map();
  blocks.sort((a, b) => {
    const mainA = a.entries[0]?.project;
    const mainB = b.entries[0]?.project;
    const rowA = mainA?.rowNumber;
    const rowB = mainB?.rowNumber;
    const infoA = rowA != null ? deps.get(rowA) : null;
    const infoB = rowB != null ? deps.get(rowB) : null;
    const blockerCountA = infoA?.devBlockerFor?.length ?? 0;
    const blockerCountB = infoB?.devBlockerFor?.length ?? 0;
    if (blockerCountB !== blockerCountA) return blockerCountB - blockerCountA;
    const plainCountA = infoA?.plainDepFor?.length ?? 0;
    const plainCountB = infoB?.plainDepFor?.length ?? 0;
    return plainCountB - plainCountA;
  });
  return blocks.flatMap(b => b.entries);
}
