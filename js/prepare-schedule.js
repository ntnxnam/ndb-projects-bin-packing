/**
 * Prepare schedule-ready data from raw imported projects.
 *
 * Pipeline:
 *   1. User loads CSV / XLSX / JSON  →  raw projects (all rows, all statuses)
 *   2. prepareScheduleData()         →  committed-only, dependency-only rows stripped,
 *                                       resource groups detected, clean fields
 *   3. Result stored as "committed-schedule" and used by Gantt / schedule views.
 *
 * @module prepare-schedule
 */

import { detectResourceGroups } from './resource-groups.js';
import { logger } from './logger.js';

/**
 * True when a row is a dependency-only placeholder (has Sl No but no real project data).
 * These appear in the Excel as rows under a project listing external dependencies
 * (e.g. rows 10-25 under DB in Containers).
 */
function isDependencyOnlyRow(p) {
  const hasSummary = (p.summary || '').trim().length > 0;
  const hasFeat = (p.feat || '').trim().length > 0;
  const hasResources = (p.totalResources || 0) > 0;
  const hasDuration = (p.durationMonths || 0) > 0;
  const hasTotalMonths = p.totalPersonMonthsNum != null && p.totalPersonMonthsNum > 0;
  const hasSizing = (p.sizingLabel || '').trim().length > 0;
  const hasPriority = (p.priority || '').trim().length > 0;
  const hasCommitment = (p.commitment || '').trim().length > 0;

  if (!hasSummary && !hasFeat && !hasResources && !hasDuration && !hasTotalMonths && !hasSizing) return true;
  if (!hasCommitment && !hasPriority && !hasResources && !hasDuration && !hasTotalMonths && !hasSizing && !hasSummary) return true;
  return false;
}

/**
 * Filter and clean raw projects into schedule-ready data.
 * Only Committed projects survive. Dependency-only rows are stripped.
 * Resource groups are detected on the clean set.
 *
 * @param {Array<object>} rawProjects - All projects from CSV/XLSX/JSON import
 * @returns {{ projects: Array<object>, dropped: number, total: number }}
 */
export function prepareScheduleData(rawProjects) {
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    return { projects: [], dropped: 0, total: 0 };
  }

  const total = rawProjects.length;
  const committed = [];

  for (const p of rawProjects) {
    if (isDependencyOnlyRow(p)) continue;

    const commitment = (p.commitment || '').trim().toLowerCase();
    if (commitment !== 'committed') continue;

    committed.push({ ...p });
  }

  detectResourceGroups(committed);

  logger.debug('prepare-schedule:', total, 'raw →', committed.length, 'committed (schedule-ready)');
  return { projects: committed, dropped: total - committed.length, total };
}
