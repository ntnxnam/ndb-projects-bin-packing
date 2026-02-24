/**
 * Project filtering and priority-tier tagging for schedule views.
 * @module filters
 */

import { norm } from './utils.js';
import { logger } from './logger.js';

/**
 * Filter projects by Priority (exact match, case-insensitive; default "P0").
 * @param {Array<object>} projects
 * @param {string} priority - e.g. "P0", "P1", or "" for all.
 * @returns {Array<object>}
 */
export function filterByPriority(projects, priority) {
  if (!priority) return projects;
  const pr = norm(priority);
  const out = projects.filter(p => norm(p.priority || 'P0') === pr);
  logger.debug('filters.filterByPriority:', priority, '->', out.length, 'of', projects.length);
  return out;
}

/**
 * Tag each project with _tier for priority-aware scheduling.
 * Tier 1 = P0, Tier 2 = P1, Tier 3 = everything else.
 * All projects are Committed (filtered upstream by prepare-schedule).
 * Resource-group children inherit their parent's tier. Mutates projectList.
 * @param {Array<object>} projectList
 */
export function tagPriorityTiers(projectList) {
  const parentTierByRow = new Map();
  for (const p of projectList) {
    if (p.isResourceGroupChild) continue;
    const pri = norm(p.priority || 'P0');
    const tier = pri === 'p0' ? 1 : pri === 'p1' ? 2 : 3;
    p._tier = tier;
    parentTierByRow.set(p.rowNumber, tier);
  }
  for (const p of projectList) {
    if (!p.isResourceGroupChild) continue;
    p._tier = parentTierByRow.get(p.resourceGroupParentRow) ?? 3;
  }
  logger.debug('filters.tagPriorityTiers: applied to', projectList.length, 'projects');
}
