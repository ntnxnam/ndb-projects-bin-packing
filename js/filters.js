/**
 * Project filtering and priority-tier tagging for schedule views.
 * @module filters
 */

import { norm } from './utils.js';
import { logger } from './logger.js';

/**
 * Filter projects by 3.0 Commitment Status (exact match, case-insensitive).
 * @param {Array<object>} projects
 * @param {string} commitment - e.g. "Committed", "Approved", or "" for all.
 * @returns {Array<object>}
 */
export function filterByCommitment(projects, commitment) {
  if (!commitment) return projects;
  const c = norm(commitment);
  const out = projects.filter(p => norm(p.commitment) === c);
  logger.debug('filters.filterByCommitment:', commitment, '->', out.length, 'of', projects.length);
  return out;
}

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
 * Tier 1 = P0 or Committed (front-loaded); Tier 2 = rest.
 * Resource-group children inherit their parent's tier. Mutates projectList.
 * @param {Array<object>} projectList
 */
export function tagPriorityTiers(projectList) {
  const parentTierByRow = new Map();
  for (const p of projectList) {
    if (p.isResourceGroupChild) continue;
    const isP0 = norm(p.priority || 'P0') === 'p0';
    const isCommitted = norm(p.commitment || '').includes('committed');
    p._tier = (isP0 || isCommitted) ? 1 : 2;
    parentTierByRow.set(p.rowNumber, p._tier);
  }
  for (const p of projectList) {
    if (!p.isResourceGroupChild) continue;
    p._tier = parentTierByRow.get(p.resourceGroupParentRow) ?? 2;
  }
  logger.debug('filters.tagPriorityTiers: applied to', projectList.length, 'projects');
}
