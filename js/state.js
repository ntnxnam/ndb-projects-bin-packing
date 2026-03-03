/**
 * Persisted application state (projects and filters) via localStorage.
 * Single contract for all pages so filters and data stay in sync.
 * @module state
 */

import { logger } from './logger.js';
import { UPLOAD_STORAGE_KEY, SCHEDULE_STORAGE_KEY, FILTERS_STORAGE_KEY, START_DATE_OVERRIDES_KEY } from './config.js';

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
 * Load schedule-ready projects (Committed-only, cleaned) from localStorage.
 * @returns {Array<object>}
 */
export function getScheduleData() {
  try {
    const raw = localStorage.getItem(SCHEDULE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    logger.debug('state.getScheduleData: loaded', parsed.length, 'projects');
    return parsed;
  } catch (e) {
    logger.warn('state.getScheduleData: invalid stored data', e);
    return [];
  }
}

/**
 * Persist schedule-ready projects to localStorage.
 * @param {Array<object>} projects
 */
export function setScheduleData(projects) {
  try {
    if (!Array.isArray(projects)) return;
    localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(projects));
    logger.debug('state.setScheduleData: saved', projects.length, 'projects');
  } catch (e) {
    logger.warn('state.setScheduleData: failed to persist', e);
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

/**
 * Load user-overridden start dates.
 * @returns {Object<string, string>} Map of rowNumber (as string key) → date string.
 */
export function getStartDateOverrides() {
  try {
    const raw = localStorage.getItem(START_DATE_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('state.getStartDateOverrides: invalid stored data', e);
    return {};
  }
}

/**
 * Set a user-overridden start date for a project.
 * @param {number} rowNumber
 * @param {string} dateStr - YYYY-MM-DD (or null to clear)
 */
export function setStartDateOverride(rowNumber, dateStr) {
  try {
    const overrides = getStartDateOverrides();
    if (dateStr) {
      overrides[String(rowNumber)] = dateStr;
    } else {
      delete overrides[String(rowNumber)];
    }
    localStorage.setItem(START_DATE_OVERRIDES_KEY, JSON.stringify(overrides));
    logger.debug('state.setStartDateOverride:', rowNumber, dateStr);
  } catch (e) {
    logger.warn('state.setStartDateOverride: failed to persist', e);
  }
}

/**
 * Apply start-date overrides to a projects array (in-place).
 * Stashes the CSV original in `_csvStartDate` before overwriting.
 * @param {Array<object>} projects
 */
export function applyStartDateOverrides(projects) {
  const overrides = getStartDateOverrides();
  for (const p of projects) {
    if (p.rowNumber == null) continue;
    const key = String(p.rowNumber);
    if (!p.hasOwnProperty('_csvStartDate')) {
      p._csvStartDate = p.requestedStartDate ?? null;
    }
    if (key in overrides) {
      p.requestedStartDate = overrides[key];
    } else {
      p.requestedStartDate = p._csvStartDate;
    }
  }
}
