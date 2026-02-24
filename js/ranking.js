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
 * Map each project rowNumber to lists of dependents: who lists this project as dev-blocker, rel-blocker, or plain dependency.
 * Used for tooltips and display order (blockers first).
 * @param {Array<object>} projectList
 * @returns {Map<number, { devBlockerFor: number[], relBlockerFor: number[], plainDepFor: number[] }>}
 */
export function getDependentsByProject(projectList) {
  const map = new Map();
  const list = projectList || [];
  for (const p of list) {
    const r = p.rowNumber;
    if (r == null) continue;
    map.set(r, { devBlockerFor: [], relBlockerFor: [], plainDepFor: [] });
  }
  for (const p of list) {
    const r = p.rowNumber;
    if (r == null) continue;
    const devBlockers = new Set(p.dependencyDevBlockers || []);
    const relBlockers = new Set(p.dependencyRelBlockers || []);
    const deps = p.dependencyRowNumbers || [];
    for (const depRow of deps) {
      if (depRow === r || !map.has(depRow)) continue;
      const entry = map.get(depRow);
      const slNo = p.rowNumber != null ? p.rowNumber : null;
      if (slNo == null) continue;
      if (devBlockers.has(depRow)) {
        if (!entry.devBlockerFor.includes(slNo)) entry.devBlockerFor.push(slNo);
      } else if (relBlockers.has(depRow)) {
        if (!entry.relBlockerFor.includes(slNo)) entry.relBlockerFor.push(slNo);
      } else {
        if (!entry.plainDepFor.includes(slNo)) entry.plainDepFor.push(slNo);
      }
    }
  }
  logger.debug('ranking.getDependentsByProject: built map for', list.length, 'projects');
  return map;
}

/**
 * Human-readable rank label for a project (e.g. "0 (In Progress)", "1 (dev n)", "2 (rel n)", "3 (plain n)", "4").
 * @param {object} project - Project with rowNumber, inProgress, resourceGroupChildRows, resourceGroupParentRow, resourceGroupName.
 * @param {{ devBlockerDependentsCount: Map<number, number>, relBlockerDependentsCount: Map<number, number>, plainDependentsCount: Map<number, number> }} counts - From getDependentsCounts.
 * @returns {string}
 */
export function getRankLabel(project, counts) {
  const blockCount = counts.devBlockerDependentsCount.get(project.rowNumber) ?? 0;
  const relCount = counts.relBlockerDependentsCount.get(project.rowNumber) ?? 0;
  const plainCount = counts.plainDependentsCount.get(project.rowNumber) ?? 0;
  const isInProgress = !!project.inProgress;
  const isChild = !!project.isResourceGroupChild;
  const isParent = !!(project.resourceGroupChildRows?.length);
  const totalBlocks = blockCount + relCount + plainCount;
  let rankText = isInProgress ? '0 (In Progress)' : blockCount > 0 ? `1 (dev ${blockCount}${totalBlocks > blockCount ? `, blocks ${totalBlocks}` : ''})` : relCount > 0 ? `2 (rel ${relCount}${totalBlocks > relCount ? `, blocks ${totalBlocks}` : ''})` : plainCount > 0 ? `3 (plain ${plainCount}, blocks ${totalBlocks})` : '4';
  const bucketName = project.resourceGroupName || '';
  const groupNote = isChild
    ? (bucketName ? ` [↳ ${bucketName}]` : ` [↳ group of ${project.resourceGroupParentRow}]`)
    : isParent
      ? (bucketName ? ` [📦 ${bucketName}: ${project.resourceGroupChildRows.length} sub]` : ` [📦 group: ${project.resourceGroupChildRows.length} sub]`)
      : '';
  return rankText + groupNote;
}

/**
 * Determine display tier for a schedule block's main entry.
 *   0 = In Progress (finish what you started)
 *   1 = Ready to Start (no unfinished dependency gates this project)
 *   2 = Waiting on Dependencies (start pushed by a dependency that ends after origin)
 */
function getTier(entry, originMs, endByRow) {
  if (entry.inProgress) return 0;

  const p = entry.project;
  const deps = p?.dependencyRowNumbers || [];
  if (deps.length === 0) return 1;

  const startMs = entry.startDate?.getTime() ?? 0;
  if (startMs <= originMs) return 1;

  for (const depRow of deps) {
    if (depRow === p.rowNumber) continue;
    const depEnd = endByRow.get(depRow);
    if (depEnd && depEnd.getTime() > originMs) return 2;
  }

  return 1;
}

/**
 * Reorder schedule for display using a 3-tier grouping:
 *
 *   Tier 0 — In Progress: sorted by end date ascending (soonest completion first)
 *   Tier 1 — Ready to Start: sorted by blocker count desc (unblocks most), then duration desc (longest first)
 *   Tier 2 — Waiting on Dependencies: sorted by start date asc (pipeline order), then blocker count desc
 *
 * Keeps resource-group parent+children together as blocks.
 *
 * @param {Array<object>} schedule - Schedule entries (project, startDate, endDate, …).
 * @param {Map<number, { devBlockerFor: number[], relBlockerFor: number[], plainDepFor: number[] }>} [dependentsByProject]
 * @returns {{ schedule: Array<object>, tierBreaks: Array<{ label: string, index: number }> }}
 */
export function orderScheduleByBlockersFirst(schedule, dependentsByProject) {
  if (!schedule?.length) return { schedule, tierBreaks: [] };

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

  const originMs = Math.min(...blocks.map(b => b.entries[0]?.startDate?.getTime() ?? Infinity));

  const endByRow = new Map();
  for (const block of blocks) {
    for (const e of block.entries) {
      const row = e.project?.rowNumber;
      if (row != null) endByRow.set(row, e.endDate);
    }
  }

  for (const block of blocks) {
    block.tier = getTier(block.entries[0], originMs, endByRow);
  }

  const blockerCount = (entry) => {
    const row = entry?.project?.rowNumber;
    if (row == null) return 0;
    const info = deps.get(row);
    if (!info) return 0;
    return (info.devBlockerFor?.length ?? 0) + (info.relBlockerFor?.length ?? 0) + (info.plainDepFor?.length ?? 0);
  };

  blocks.sort((a, b) => {
    const mainA = a.entries[0];
    const mainB = b.entries[0];

    if (a.tier !== b.tier) return a.tier - b.tier;

    if (a.tier === 0) {
      const endA = mainA?.endDate?.getTime() ?? 0;
      const endB = mainB?.endDate?.getTime() ?? 0;
      return endA - endB;
    }

    if (a.tier === 1) {
      const bA = blockerCount(mainA);
      const bB = blockerCount(mainB);
      if (bB !== bA) return bB - bA;

      const durA = (mainA?.endDate?.getTime() ?? 0) - (mainA?.startDate?.getTime() ?? 0);
      const durB = (mainB?.endDate?.getTime() ?? 0) - (mainB?.startDate?.getTime() ?? 0);
      if (durB !== durA) return durB - durA;

      return (mainA?.startDate?.getTime() ?? 0) - (mainB?.startDate?.getTime() ?? 0);
    }

    /* Tier 2: earliest start first, then most blockers */
    const startA = mainA?.startDate?.getTime() ?? 0;
    const startB = mainB?.startDate?.getTime() ?? 0;
    if (startA !== startB) return startA - startB;

    const bA = blockerCount(mainA);
    const bB = blockerCount(mainB);
    if (bB !== bA) return bB - bA;

    const endA = mainA?.endDate?.getTime() ?? 0;
    const endB = mainB?.endDate?.getTime() ?? 0;
    return endA - endB;
  });

  const tierLabels = ['In Progress', 'Ready to Start', 'Waiting on Dependencies'];
  const flatSchedule = [];
  const tierBreaks = [];
  let lastTier = -1;

  for (const block of blocks) {
    if (block.tier !== lastTier) {
      tierBreaks.push({ label: tierLabels[block.tier] ?? `Tier ${block.tier}`, index: flatSchedule.length });
      lastTier = block.tier;
    }
    for (const e of block.entries) {
      flatSchedule.push(e);
    }
  }

  logger.debug('ranking: 3-tier display —', tierBreaks.map(t => `${t.label} @${t.index}`).join(', '));
  return { schedule: flatSchedule, tierBreaks };
}
