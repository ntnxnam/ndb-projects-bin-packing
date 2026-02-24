/**
 * Persisted application state (projects and filters) via localStorage.
 * Single contract for all pages so filters and data stay in sync.
 * @module state
 */

import { logger } from './logger.js';
import { UPLOAD_STORAGE_KEY, FILTERS_STORAGE_KEY } from './config.js';

/**
 * Load projects from localStorage (previously uploaded CSV/JSON).
 * @returns {Array<object>} Project objects, or empty array if none or invalid.
 */
export function getProjects() {
  try {
    const raw = localStorage.getItem(UPLOAD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    logger.debug('state.getProjects: loaded', parsed.length, 'projects');
    return parsed;
  } catch (e) {
    logger.warn('state.getProjects: invalid stored data', e);
    return [];
  }
}

/**
 * Persist projects to localStorage (e.g. after upload/submit).
 * @param {Array<object>} projects
 */
export function setProjects(projects) {
  try {
    if (!Array.isArray(projects)) return;
    localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(projects));
    logger.debug('state.setProjects: saved', projects.length, 'projects');
  } catch (e) {
    logger.warn('state.setProjects: failed to persist', e);
  }
}

/**
 * @typedef {object} FilterState
 * @property {string} commitment - e.g. "Committed", "Approved", ""
 * @property {string} priority - e.g. "P0", "P1", ""
 */

/**
 * Load last-used filters from localStorage (optional; pages can use defaults).
 * @returns {FilterState}
 */
export function getFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return { commitment: '', priority: '' };
    const parsed = JSON.parse(raw);
    return {
      commitment: String(parsed.commitment ?? '').trim(),
      priority: String(parsed.priority ?? '').trim(),
    };
  } catch (e) {
    logger.warn('state.getFilters: invalid stored data', e);
    return { commitment: '', priority: '' };
  }
}

/**
 * Persist filter state so other pages can pre-fill (e.g. Schedule → Bottom-up).
 * @param {FilterState} filters
 */
export function setFilters(filters) {
  try {
    if (!filters || typeof filters !== 'object') return;
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
      commitment: String(filters.commitment ?? '').trim(),
      priority: String(filters.priority ?? '').trim(),
    }));
    logger.debug('state.setFilters: saved', filters);
  } catch (e) {
    logger.warn('state.setFilters: failed to persist', e);
  }
}
